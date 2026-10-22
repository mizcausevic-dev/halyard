import { createHmac } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import {
  isTrigger,
  jsonByteLength,
  LIMITS,
  safeGet,
  type WorkflowDocument,
} from "@halyard/core";
import { createUser, login, logout, userFromToken, type SessionUser } from "./auth.js";
import { decryptJson, encryptJson, hashPassword, safeEqual } from "./crypto.js";
import { getPool, isUniqueViolation, withTx } from "./db.js";
import { loadConfig } from "./env.js";
import { cancelRun, insertRun } from "./engine.js";
import { ApiError } from "./errors.js";
import { workspaceSecrets } from "./secrets.js";
import { createWorkflow, publishWorkflow, restoreVersion, saveDraft } from "./workflows.js";

type Role = "owner" | "editor" | "operator" | "viewer";
const RANK: Record<Role, number> = { viewer: 1, operator: 2, editor: 3, owner: 4 };

type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  user: SessionUser | null;
};

const JSON_MAX = LIMITS.maxPayloadBytes;

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function cookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function sessionCookie(token: string, maxAge: number): string {
  const secure = (process.env.HALYARD_ENV ?? "production") === "production" ? "; Secure" : "";
  return `halyard_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

async function readBody(req: IncomingMessage, max = JSON_MAX): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > max) throw new ApiError(413, "payload_too_large", "Request body exceeds the limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be a JSON object.");
  }
}

function guardMutation(ctx: Ctx): void {
  if (ctx.req.headers["x-halyard-client"] !== "1") {
    throw new ApiError(400, "missing_client_header", "Mutations require the Halyard client header.");
  }
  const origin = ctx.req.headers.origin;
  const allowed = loadConfig().origins;
  if (origin && allowed.length > 0 && !allowed.includes(origin)) {
    throw new ApiError(403, "origin_rejected", "This origin is not allowed to call the API.");
  }
}

async function member(userId: string, workspaceId: string): Promise<Role | null> {
  const result = await getPool().query<{ role: Role }>("SELECT role FROM memberships WHERE user_id = $1 AND workspace_id = $2", [userId, workspaceId]);
  return result.rows[0]?.role ?? null;
}

function allow(role: Role, minimum: Role): void {
  if (RANK[role] < RANK[minimum]) throw new ApiError(403, "forbidden", "This role cannot do that.");
}

function presentRun(row: Record<string, unknown>, role: Role) {
  const restricted = role === "viewer";
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    status: row.status,
    triggerType: row.trigger_type,
    triggerPayload: restricted ? null : row.trigger_payload,
    payloadRestricted: restricted,
    error: restricted && row.error ? { code: "restricted", message: "Execution details are restricted for viewers." } : row.error,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    deadlineAt: row.deadline_at,
    scheduledFor: row.scheduled_for,
    cancelRequestedAt: row.cancel_requested_at,
  };
}

function presentStep(row: Record<string, unknown>, role: Role) {
  const restricted = role === "viewer";
  return {
    id: row.id,
    nodeId: row.node_id,
    nodeType: row.node_type,
    status: row.status,
    attempt: row.attempt,
    selectedPort: row.selected_port,
    input: restricted ? null : row.input,
    output: restricted ? null : row.output,
    error: restricted && row.error ? { code: "restricted", message: "Execution details are restricted for viewers." } : row.error,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    wakeAt: row.wake_at,
    payloadRestricted: restricted,
  };
}

async function bumpRate(key: string, limit: number): Promise<void> {
  const windowStart = new Date();
  windowStart.setUTCSeconds(0, 0);
  const result = await getPool().query<{ count: number }>(
    `INSERT INTO rate_buckets (bucket_key, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = rate_buckets.count + 1
     RETURNING count`,
    [key, windowStart],
  );
  if ((result.rows[0]?.count ?? 0) > limit) throw new ApiError(429, "rate_limited", "Too many requests. Try again next minute.");
}

export function createHandler(staticDir: string | null = null) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    try {
      if (url.pathname.startsWith("/hooks/")) {
        await webhook(req, res, url.pathname.slice("/hooks/".length));
        return;
      }
      if (url.pathname === "/api/health") {
        await getPool().query("SELECT 1");
        send(res, 200, { ok: true, service: "halyard" });
        return;
      }
      const user = await userFromToken(cookie(req, "halyard_session"));
      const ctx: Ctx = { req, res, url, params: {}, user };
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") guardMutation(ctx);
      const handled = await route(ctx);
      if (!handled && staticDir) {
        serveStatic(req, res, staticDir, url.pathname);
        return;
      }
      if (!handled) send(res, 404, { error: { code: "not_found", message: "No route matches this request." } });
    } catch (error) {
      if (error instanceof ApiError) {
        send(res, error.status, { error: { code: error.code, message: error.message, details: error.details ?? null } });
        return;
      }
      console.log(JSON.stringify({ level: "error", message: "request failed", error: error instanceof Error ? error.message : "error" }));
      send(res, 500, { error: { code: "internal", message: "The request failed." } });
    }
  };
}

function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, pathname: string): void {
  const safe = pathname === "/" ? "/index.html" : pathname;
  const file = normalize(join(root, safe));
  if (!file.startsWith(normalize(root)) || !existsSync(file) || statSync(file).isDirectory()) {
    const index = join(root, "index.html");
    if (!existsSync(index)) {
      send(res, 404, { error: { code: "not_found", message: "Not found." } });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    createReadStream(index).pipe(res);
    return;
  }
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
  res.writeHead(req.method === "HEAD" ? 200 : 200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}

async function route(ctx: Ctx): Promise<boolean> {
  const { req, res, url } = ctx;
  const method = req.method ?? "GET";
  const path = url.pathname;
  if (method === "POST" && path === "/api/auth/login") {
    const body = await readJson(req);
    const email = String(body.email ?? "").toLowerCase();
    await bumpRate(`login:${req.socket.remoteAddress ?? "local"}:${email}`, 10);
    const session = await login(email, String(body.password ?? ""));
    if (!session) throw new ApiError(401, "invalid_login", "Email or password is wrong.");
    res.setHeader("set-cookie", sessionCookie(session.token, 7 * 24 * 60 * 60));
    send(res, 200, { user: session.user });
    return true;
  }
  if (method === "POST" && path === "/api/auth/logout") {
    await logout(cookie(req, "halyard_session"));
    res.setHeader("set-cookie", sessionCookie("", 0));
    send(res, 200, { ok: true });
    return true;
  }
  if (method === "GET" && path === "/api/me") {
    if (!ctx.user) throw new ApiError(401, "unauthenticated", "Sign in required.");
    const workspaces = await getPool().query("SELECT w.id, w.name, w.slug, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY w.name", [ctx.user.id]);
    send(res, 200, { user: ctx.user, workspaces: workspaces.rows });
    return true;
  }
  const workspace = path.match(/^\/api\/workspaces\/([^/]+)(.*)$/);
  if (!workspace) return false;
  if (!ctx.user) throw new ApiError(401, "unauthenticated", "Sign in required.");
  const workspaceId = decodeURIComponent(workspace[1] ?? "");
  const rest = workspace[2] || "";
  const role = await member(ctx.user.id, workspaceId);
  if (!role) throw new ApiError(404, "not_found", "Workspace not found.");
  if (method === "GET" && rest === "") {
    const row = await getPool().query("SELECT id, name, slug, created_at FROM workspaces WHERE id = $1", [workspaceId]);
    send(res, 200, { workspace: row.rows[0], role });
    return true;
  }
  if (method === "GET" && rest === "/dashboard") {
    const counts = await getPool().query("SELECT status, count(*)::int AS count FROM runs WHERE workspace_id = $1 AND created_at > now() - interval '7 days' GROUP BY status", [workspaceId]);
    const recent = await getPool().query("SELECT r.*, w.name AS workflow_name FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.workspace_id = $1 ORDER BY r.created_at DESC LIMIT 8", [workspaceId]);
    const workflows = await getPool().query("SELECT count(*)::int AS count FROM workflows WHERE workspace_id = $1", [workspaceId]);
    const scoped = await getPool().query(
      `SELECT s.id, s.workflow_id, w.name AS workflow_name, s.cron, s.timezone, s.missed_policy, s.next_fire_at, s.enabled
       FROM schedules s JOIN workflows w ON w.id = s.workflow_id
       WHERE s.workspace_id = $1 AND s.enabled = true ORDER BY s.next_fire_at LIMIT 5`,
      [workspaceId],
    );
    send(res, 200, {
      workflowCount: workflows.rows[0]?.count ?? 0,
      runCounts: counts.rows,
      recentRuns: recent.rows.map((row) => ({ ...presentRun(row, role), workflowName: row.workflow_name })),
      schedules: scoped.rows,
    });
    return true;
  }
  if (rest === "/workflows" && method === "GET") {
    const rows = await getPool().query(
      `SELECT w.id, w.name, w.slug, w.description, w.updated_at, w.published_version_id,
              d.revision AS draft_revision, p.version_number AS published_version
       FROM workflows w
       LEFT JOIN workflow_versions d ON d.workflow_id = w.id AND d.status = 'draft'
       LEFT JOIN workflow_versions p ON p.id = w.published_version_id
       WHERE w.workspace_id = $1 ORDER BY w.updated_at DESC`,
      [workspaceId],
    );
    send(res, 200, { workflows: rows.rows });
    return true;
  }
  if (rest === "/workflows" && method === "POST") {
    allow(role, "editor");
    const body = await readJson(req);
    const created = await withTx((client) => createWorkflow(client, workspaceId, String(body.name ?? "Untitled workflow"), String(body.description ?? "")));
    send(res, 201, created);
    return true;
  }
  if (rest === "/workflows/import" && method === "POST") {
    allow(role, "editor");
    const body = await readJson(req);
    const created = await withTx((client) => createWorkflow(client, workspaceId, "Imported", "", body.document));
    send(res, 201, created);
    return true;
  }
  const workflowMatch = rest.match(/^\/workflows\/([^/]+)(.*)$/);
  if (workflowMatch) {
    const workflowId = decodeURIComponent(workflowMatch[1] ?? "");
    const tail = workflowMatch[2] || "";
    const owned = await getPool().query("SELECT id FROM workflows WHERE id = $1 AND workspace_id = $2", [workflowId, workspaceId]);
    if (owned.rowCount === 0) throw new ApiError(404, "not_found", "Workflow not found.");
    if (method === "GET" && tail === "") {
      const workflow = await getPool().query("SELECT * FROM workflows WHERE id = $1", [workflowId]);
      const draft = await getPool().query("SELECT id, revision, document, created_at FROM workflow_versions WHERE workflow_id = $1 AND status = 'draft'", [workflowId]);
      const hook = await getPool().query("SELECT id, token, auth_mode, event_id_path, rate_limit_per_minute, enabled, secret_header, signature_header FROM webhook_endpoints WHERE workflow_id = $1", [workflowId]);
      const schedule = await getPool().query("SELECT id, cron, timezone, missed_policy, next_fire_at, enabled FROM schedules WHERE workflow_id = $1", [workflowId]);
      send(res, 200, { workflow: workflow.rows[0], draft: draft.rows[0] ?? null, webhook: hook.rows[0] ?? null, schedule: schedule.rows[0] ?? null });
      return true;
    }
    if (method === "PUT" && tail === "/draft") {
      allow(role, "editor");
      const body = await readJson(req);
      const expectedRevision = body.expectedRevision;
      if (typeof expectedRevision !== "number") throw new ApiError(400, "revision_required", "expectedRevision is required.");
      const saved = await withTx((client) => saveDraft(client, workspaceId, workflowId, body.document, expectedRevision));
      send(res, 200, saved);
      return true;
    }
    if (method === "POST" && tail === "/publish") {
      allow(role, "editor");
      const published = await withTx((client) => publishWorkflow(client, workspaceId, workflowId));
      send(res, 200, published);
      return true;
    }
    if (method === "GET" && tail === "/versions") {
      const versions = await getPool().query("SELECT id, version_number, status, revision, published_at, created_at, document FROM workflow_versions WHERE workflow_id = $1 ORDER BY version_number", [workflowId]);
      send(res, 200, { versions: versions.rows });
      return true;
    }
    if (method === "POST" && tail === "/restore") {
      allow(role, "editor");
      const body = await readJson(req);
      const restored = await withTx((client) => restoreVersion(client, workspaceId, workflowId, String(body.versionId ?? ""), Number(body.expectedRevision)));
      send(res, 200, restored);
      return true;
    }
    if (method === "GET" && tail === "/export") {
      const source = url.searchParams.get("source") === "draft" ? "draft" : "published";
      const version = source === "draft"
        ? await getPool().query<{ document: WorkflowDocument }>("SELECT document FROM workflow_versions WHERE workflow_id = $1 AND status = 'draft'", [workflowId])
        : await getPool().query<{ document: WorkflowDocument }>("SELECT v.document FROM workflows w JOIN workflow_versions v ON v.id = w.published_version_id WHERE w.id = $1", [workflowId]);
      const document = version.rows[0]?.document;
      if (!document) throw new ApiError(404, "not_found", source === "published" ? "Nothing has been published yet." : "Draft not found.");
      send(res, 200, { document });
      return true;
    }
    if (method === "POST" && tail === "/run") {
      allow(role, "operator");
      const body = await readJson(req);
      const payload = body.payload ?? {};
      if (jsonByteLength(payload) > LIMITS.maxPayloadBytes) throw new ApiError(413, "payload_too_large", "Run payload exceeds the limit.");
      const published = await getPool().query<{ id: string; document: WorkflowDocument }>(
        "SELECT v.id, v.document FROM workflows w JOIN workflow_versions v ON v.id = w.published_version_id WHERE w.id = $1 AND w.workspace_id = $2",
        [workflowId, workspaceId],
      );
      const version = published.rows[0];
      if (!version) throw new ApiError(409, "unpublished", "Publish the workflow before running it.");
      const trigger = version.document.nodes.find((node) => isTrigger(node.type) && !node.iterationParent);
      if (!trigger) throw new ApiError(409, "publish_invalid", "The published version has no trigger.");
      const at = new Date().toISOString();
      const triggerOutput = trigger.type === "schedule_trigger"
        ? { kind: "schedule", at, scheduledFor: at, timezone: trigger.config.timezone, cron: trigger.config.cron, missed: false, manualRun: true, body: payload }
        : trigger.type === "webhook_trigger"
          ? { kind: "webhook", at, eventId: null, manualRun: true, body: payload }
          : { kind: "manual", at, body: payload };
      const secrets = await workspaceSecrets(workspaceId);
      const created = await withTx((client) => insertRun(client, {
        workspaceId,
        workflowId,
        versionId: version.id,
        document: version.document,
        triggerType: trigger.type === "manual_trigger" ? "manual" : trigger.type === "schedule_trigger" ? "schedule" : "webhook",
        triggerOutput,
        secrets,
      }));
      send(res, 202, created);
      return true;
    }
    return false;
  }
  if (method === "GET" && rest === "/runs") {
    const workflowId = url.searchParams.get("workflowId");
    const rows = await getPool().query(
      `SELECT r.*, w.name AS workflow_name FROM runs r JOIN workflows w ON w.id = r.workflow_id
       WHERE r.workspace_id = $1 AND ($2::uuid IS NULL OR r.workflow_id = $2)
       ORDER BY r.created_at DESC LIMIT 100`,
      [workspaceId, workflowId],
    );
    send(res, 200, { runs: rows.rows.map((row) => ({ ...presentRun(row, role), workflowName: row.workflow_name })) });
    return true;
  }
  const runMatch = rest.match(/^\/runs\/([^/]+)(.*)$/);
  if (runMatch && method === "GET" && (runMatch[2] ?? "") === "") {
    const runId = decodeURIComponent(runMatch[1] ?? "");
    const run = await getPool().query("SELECT r.*, w.name AS workflow_name, v.version_number FROM runs r JOIN workflows w ON w.id = r.workflow_id JOIN workflow_versions v ON v.id = r.workflow_version_id WHERE r.id = $1 AND r.workspace_id = $2", [runId, workspaceId]);
    if (run.rowCount === 0) throw new ApiError(404, "not_found", "Run not found.");
    const steps = await getPool().query("SELECT * FROM steps WHERE run_id = $1 ORDER BY queued_at, node_id", [runId]);
    const logs = role === "viewer" ? [] : (await getPool().query("SELECT level, message, created_at, step_id FROM run_logs WHERE run_id = $1 ORDER BY id", [runId])).rows;
    const version = await getPool().query("SELECT document FROM workflow_versions WHERE id = $1", [run.rows[0].workflow_version_id]);
    send(res, 200, {
      run: { ...presentRun(run.rows[0], role), workflowName: run.rows[0].workflow_name, versionNumber: run.rows[0].version_number },
      steps: steps.rows.map((row) => presentStep(row, role)),
      logs,
      document: version.rows[0]?.document ?? null,
    });
    return true;
  }
  if (runMatch && method === "POST" && runMatch[2] === "/cancel") {
    allow(role, "operator");
    const updated = await cancelRun(workspaceId, decodeURIComponent(runMatch[1] ?? ""));
    if (!updated) throw new ApiError(404, "not_found", "Run not found.");
    send(res, 200, { run: presentRun(updated as unknown as Record<string, unknown>, role) });
    return true;
  }
  if (rest === "/credentials" && method === "GET") {
    allow(role, "editor");
    const rows = await getPool().query("SELECT id, name, kind, header_name, key_version, created_at, updated_at FROM credentials WHERE workspace_id = $1 ORDER BY name", [workspaceId]);
    send(res, 200, { credentials: rows.rows });
    return true;
  }
  if (rest === "/credentials" && method === "POST") {
    allow(role, "editor");
    const body = await readJson(req);
    const name = String(body.name ?? "").trim();
    const kind = String(body.kind ?? "");
    if (!name || !["bearer", "header", "basic", "hmac", "shared_secret"].includes(kind)) {
      throw new ApiError(400, "invalid_credential", "Name and a supported kind are required.");
    }
    const secret = kind === "basic"
      ? { username: String(body.username ?? ""), password: String(body.password ?? "") }
      : { value: String(body.value ?? "") };
    const secretText = "password" in secret ? secret.password : secret.value;
    if (!secretText) throw new ApiError(400, "invalid_credential", "The secret value is empty.");
    const encrypted = encryptJson(secret);
    const row = await getPool().query(
      "INSERT INTO credentials (workspace_id, name, kind, header_name, ciphertext, key_version) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, kind, header_name, key_version, created_at",
      [workspaceId, name, kind, body.headerName ? String(body.headerName) : null, encrypted.ciphertext, encrypted.keyVersion],
    );
    send(res, 201, { credential: row.rows[0] });
    return true;
  }
  const credentialMatch = rest.match(/^\/credentials\/([^/]+)$/);
  if (credentialMatch && method === "DELETE") {
    allow(role, "owner");
    const deleted = await getPool().query("DELETE FROM credentials WHERE id = $1 AND workspace_id = $2 RETURNING id", [decodeURIComponent(credentialMatch[1] ?? ""), workspaceId]);
    if (deleted.rowCount === 0) throw new ApiError(404, "not_found", "Credential not found.");
    send(res, 200, { ok: true });
    return true;
  }
  if (rest === "/hooks" && method === "GET") {
    const rows = await getPool().query(
      `SELECT h.id, h.workflow_id, w.name AS workflow_name, h.token, h.auth_mode, h.event_id_path, h.rate_limit_per_minute, h.enabled, h.secret_header, h.signature_header
       FROM webhook_endpoints h JOIN workflows w ON w.id = h.workflow_id WHERE h.workspace_id = $1 ORDER BY w.name`,
      [workspaceId],
    );
    send(res, 200, { hooks: rows.rows.map((row) => ({ ...row, path: `/hooks/${row.token}` })) });
    return true;
  }
  if (rest === "/schedules" && method === "GET") {
    const rows = await getPool().query(
      `SELECT s.*, w.name AS workflow_name FROM schedules s JOIN workflows w ON w.id = s.workflow_id WHERE s.workspace_id = $1 ORDER BY w.name`,
      [workspaceId],
    );
    send(res, 200, { schedules: rows.rows });
    return true;
  }
  if (rest === "/members" && method === "GET") {
    const rows = await getPool().query("SELECT u.id, u.email, u.name, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY u.email", [workspaceId]);
    send(res, 200, { members: rows.rows });
    return true;
  }
  if (rest === "/members" && method === "POST") {
    allow(role, "owner");
    const body = await readJson(req);
    const email = String(body.email ?? "").toLowerCase();
    const name = String(body.name ?? "").trim();
    const password = String(body.password ?? "");
    const nextRole = String(body.role ?? "viewer");
    if (!email.includes("@") || !name || !["owner", "editor", "operator", "viewer"].includes(nextRole)) {
      throw new ApiError(400, "invalid_member", "Email, name, and role are required.");
    }
    try {
      const passwordHash = await hashPassword(password);
      const created = await withTx(async (client) => {
        const user = await client.query("INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name", [email, name, passwordHash]);
        await client.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)", [workspaceId, user.rows[0].id, nextRole]);
        return user.rows[0];
      });
      send(res, 201, { member: { ...created, role: nextRole }, passwordOnce: password });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, "email_exists", "A user with that email already exists.");
      throw error;
    }
    return true;
  }
  const memberMatch = rest.match(/^\/members\/([^/]+)$/);
  if (memberMatch && method === "PATCH") {
    allow(role, "owner");
    const body = await readJson(req);
    const nextRole = String(body.role ?? "");
    if (!["owner", "editor", "operator", "viewer"].includes(nextRole)) throw new ApiError(400, "invalid_member", "Unknown role.");
    const userId = decodeURIComponent(memberMatch[1] ?? "");
    if (userId === ctx.user.id && nextRole !== "owner") throw new ApiError(400, "last_owner", "You cannot remove your own owner role from this screen.");
    const updated = await getPool().query("UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2 RETURNING role", [workspaceId, userId, nextRole]);
    if (updated.rowCount === 0) throw new ApiError(404, "not_found", "Member not found.");
    send(res, 200, { ok: true, role: nextRole });
    return true;
  }
  return false;
}

function jsonContent(header: string | undefined): boolean {
  return (header ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
}

async function webhook(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  if ((req.method ?? "GET") !== "POST") throw new ApiError(405, "method_not_allowed", "Webhooks accept POST.");
  if (!jsonContent(req.headers["content-type"])) throw new ApiError(415, "unsupported_media", "Content-Type must be application/json.");
  const endpointResult = await getPool().query(
    `SELECT h.*, w.published_version_id
     FROM webhook_endpoints h JOIN workflows w ON w.id = h.workflow_id
     WHERE h.token = $1`,
    [token],
  );
  const endpoint = endpointResult.rows[0];
  if (!endpoint || !endpoint.enabled) throw new ApiError(404, "not_found", "Webhook not found.");
  const raw = await readBody(req, LIMITS.maxWebhookBytes);
  await bumpRate(`hook:${endpoint.id}`, endpoint.rate_limit_per_minute);
  if (endpoint.auth_mode === "shared_secret" || endpoint.auth_mode === "hmac_sha256") {
    if (!endpoint.credential_id) throw new ApiError(401, "webhook_unauthorized", "Webhook authentication failed.");
    const credential = await getPool().query("SELECT ciphertext, kind FROM credentials WHERE id = $1 AND workspace_id = $2", [endpoint.credential_id, endpoint.workspace_id]);
    const row = credential.rows[0];
    if (!row) throw new ApiError(401, "webhook_unauthorized", "Webhook authentication failed.");
    const plain = decryptJson(row.ciphertext) as { value?: string };
    const secret = plain.value ?? "";
    if (endpoint.auth_mode === "shared_secret") {
      const headerName = String(endpoint.secret_header ?? "X-Halyard-Secret").toLowerCase();
      const presented = String(req.headers[headerName] ?? "");
      if (!presented || !safeEqual(presented, secret)) throw new ApiError(401, "webhook_unauthorized", "Webhook authentication failed.");
    } else {
      const headerName = String(endpoint.signature_header ?? "X-Halyard-Signature").toLowerCase();
      const presented = String(req.headers[headerName] ?? "").replace(/^sha256=/, "");
      const expected = createHmac("sha256", secret).update(raw).digest("hex");
      if (!presented || !safeEqual(presented, expected)) throw new ApiError(401, "webhook_unauthorized", "Webhook authentication failed.");
    }
  }
  let body: unknown;
  try {
    body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch {
    throw new ApiError(400, "invalid_json", "Webhook body must be JSON.");
  }
  const eventId = endpoint.event_id_path ? readEventId(body, String(endpoint.event_id_path)) : null;
  const published = await getPool().query<{ id: string; document: WorkflowDocument }>("SELECT id, document FROM workflow_versions WHERE id = $1 AND status = 'published'", [endpoint.published_version_id]);
  const version = published.rows[0];
  if (!version) throw new ApiError(409, "unpublished", "The workflow has no published version.");
  const secrets = await workspaceSecrets(endpoint.workspace_id);
  const created = await withTx((client) => insertRun(client, {
    workspaceId: endpoint.workspace_id,
    workflowId: endpoint.workflow_id,
    versionId: version.id,
    document: version.document,
    triggerType: "webhook",
    triggerOutput: { kind: "webhook", at: new Date().toISOString(), eventId, body },
    idempotencyKey: eventId ? `webhook:${eventId}` : null,
    secrets,
  }));
  send(res, created.duplicate ? 200 : 202, { runId: created.runId, duplicate: created.duplicate });
}

function readEventId(body: unknown, path: string): string | null {
  const value = safeGet(body, path);
  if (typeof value === "string" && value.length > 0 && value.length <= 200) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export async function ensureDemoUser(): Promise<void> {
  if (process.env.HALYARD_SEED !== "true") return;
  const email = (process.env.DEMO_USER_EMAIL ?? "ada@halyard.dev").toLowerCase();
  const existing = await getPool().query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rowCount) return;
  await createUser(email, process.env.DEMO_USER_NAME ?? "Ada Quartermain", process.env.DEMO_USER_PASSWORD ?? "halyard-dev-password");
}
