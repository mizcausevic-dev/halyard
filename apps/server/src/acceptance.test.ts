import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { EXAMPLE_CREDENTIAL_ID, exampleDocuments } from "@halyard/core";

process.env.HALYARD_ENV = "test";
process.env.DATABASE_URL = "postgres://halyard:halyard@127.0.0.1:5432/halyard_test";
process.env.CREDENTIAL_ENCRYPTION_KEY = "aGFseWFyZC1kZXYta2V5LW5vdC1mb3ItcHJvZCEhISE=";
process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = "1";
process.env.HALYARD_SSRF_ALLOW_HOSTS = "127.0.0.1";
process.env.HALYARD_ORIGIN = "http://127.0.0.1";
process.env.HALYARD_SEED = "false";
process.env.WORKER_LEASE_MS = "30000";

const { migrate } = await import("./migrate.js");
const { getPool, closePool } = await import("./db.js");
const { createHandler } = await import("./httpapp.js");
const { drain } = await import("./engine.js");
const { fireDueSchedules } = await import("./scheduler.js");
const { safeFetch } = await import("./http-out.js");
const { encryptJson } = await import("./crypto.js");
const { createUser } = await import("./auth.js");

let base = "";
let server: Server;
let fixture: ChildProcess;

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(80);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function api(path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-halyard-client": "1",
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  const rawCookie = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const cookie = rawCookie.map((entry) => entry.split(";")[0]).join("; ");
  return { status: response.status, json, cookie };
}

async function resetDb(): Promise<void> {
  await getPool().query(`TRUNCATE TABLE
    run_logs, jobs, steps, runs, rate_buckets, schedules, webhook_endpoints, credentials,
    workflow_versions, workflows, memberships, sessions, users, workspaces
    RESTART IDENTITY CASCADE`);
}

async function owner() {
  const email = `ada-${Math.random().toString(16).slice(2)}@halyard.dev`;
  const user = await createUser(email, "Ada Quartermain", "halyard-dev-password");
  const workspace = await getPool().query("INSERT INTO workspaces (name, slug) VALUES ('Studio', $1) RETURNING id", [`studio-${user.id.slice(0, 8)}`]);
  await getPool().query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspace.rows[0].id, user.id]);
  const session = await api("/api/auth/login", { method: "POST", body: { email, password: "halyard-dev-password" } });
  assert.equal(session.status, 200, JSON.stringify(session.json));
  return { cookie: session.cookie, workspaceId: workspace.rows[0].id as string, userId: user.id as string, email };
}

async function importAndPublish(cookie: string, workspaceId: string, document: unknown) {
  const imported = await api(`/api/workspaces/${workspaceId}/workflows/import`, { method: "POST", cookie, body: { document } });
  assert.equal(imported.status, 201, JSON.stringify(imported.json));
  const workflowId = imported.json.workflow.id as string;
  const published = await api(`/api/workspaces/${workspaceId}/workflows/${workflowId}/publish`, { method: "POST", cookie, body: {} });
  return { workflowId, published, revision: imported.json.draft.revision as number };
}

test.before(async () => {
  await migrate();
  fixture = spawn("node", ["--import", "tsx", "apps/fixture/src/main.ts"], {
    cwd: "/agent/halyard",
    env: { ...process.env, FIXTURE_PORT: "4099" },
    stdio: "ignore",
  });
  await waitFor("fixture", async () => {
    try {
      const response = await fetch("http://127.0.0.1:4099/health");
      return response.ok;
    } catch {
      return false;
    }
  });
  server = createServer(createHandler());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port.");
  base = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  fixture?.kill("SIGKILL");
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

test.beforeEach(async () => {
  await resetDb();
  await fetch("http://127.0.0.1:4099/__reset", { method: "POST" });
});

test("publish and run the iteration example, then inspect each node", async () => {
  const session = await owner();
  const examples = exampleDocuments();
  const { workflowId, published } = await importAndPublish(session.cookie, session.workspaceId, examples.batch);
  assert.equal(published.status, 200, JSON.stringify(published.json));
  const sample = (examples.batch.nodes.find((node) => node.id === "start") as { config: { samplePayload?: unknown } }).config.samplePayload;
  const started = await api(`/api/workspaces/${session.workspaceId}/workflows/${workflowId}/run`, {
    method: "POST",
    cookie: session.cookie,
    body: { payload: sample },
  });
  assert.equal(started.status, 202, JSON.stringify(started.json));
  await drain("test-worker", 40);
  const detail = await api(`/api/workspaces/${session.workspaceId}/runs/${started.json.runId}`, { cookie: session.cookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.run.status, "succeeded");
  assert.equal(detail.json.run.workflowVersionId, published.json.versionId);
  const steps = detail.json.steps as Array<{ nodeId: string; status: string; output: any; input: any; attempt: number }>;
  const batch = steps.find((step) => step.nodeId === "batch");
  assert.equal(batch?.status, "succeeded");
  assert.equal(batch?.output.count, 3);
  assert.equal(steps.find((step) => step.nodeId === "check@0")?.status, "succeeded");
  assert.equal(steps.find((step) => step.nodeId === "approved@0")?.status, "succeeded");
  assert.equal(steps.find((step) => step.nodeId === "held@0")?.status, "skipped");
  assert.equal(steps.find((step) => step.nodeId === "held@1")?.status, "succeeded");
  assert.equal(steps.find((step) => step.nodeId === "approved@1")?.status, "skipped");
  const summary = steps.find((step) => step.nodeId === "summary");
  assert.equal(summary?.status, "succeeded");
  assert.equal(summary?.input.count, 3);
  assert.ok(steps.every((step) => step.input !== undefined));
});

test("cyclic graphs publish as an error and drafts can still be saved", async () => {
  const session = await owner();
  const doc = {
    schemaVersion: 1,
    name: "Cycle",
    description: "",
    settings: { parallelism: 1, runTimeoutMs: 60_000 },
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", config: {} },
      { id: "left", type: "transform", name: "Left", config: { steps: [] } },
      { id: "right", type: "transform", name: "Right", config: { steps: [] } },
    ],
    edges: [
      { id: "a", source: "start", sourcePort: "out", target: "left", targetPort: "in" },
      { id: "b", source: "left", sourcePort: "out", target: "right", targetPort: "in" },
      { id: "c", source: "right", sourcePort: "out", target: "left", targetPort: "in" },
    ],
  };
  const imported = await api(`/api/workspaces/${session.workspaceId}/workflows/import`, { method: "POST", cookie: session.cookie, body: { document: doc } });
  assert.equal(imported.status, 201, JSON.stringify(imported.json));
  const published = await api(`/api/workspaces/${session.workspaceId}/workflows/${imported.json.workflow.id}/publish`, { method: "POST", cookie: session.cookie, body: {} });
  assert.equal(published.status, 400);
  assert.equal(published.json.error.code, "publish_invalid");
  assert.ok(published.json.error.details.some((issue: { code: string }) => issue.code === "cycle"));
});

test("cancel a waiting delay without running the downstream node", async () => {
  const session = await owner();
  const doc = {
    schemaVersion: 1,
    name: "Wait",
    description: "",
    settings: { parallelism: 1, runTimeoutMs: 60_000 },
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", config: {} },
      { id: "wait", type: "delay", name: "Wait", config: { durationMs: 3_600_000 } },
      { id: "done", type: "output", name: "Done", config: { level: "info", message: "after wait", classification: "log" } },
    ],
    edges: [
      { id: "a", source: "start", sourcePort: "out", target: "wait", targetPort: "in" },
      { id: "b", source: "wait", sourcePort: "out", target: "done", targetPort: "in" },
    ],
  };
  const { workflowId } = await importAndPublish(session.cookie, session.workspaceId, doc);
  const started = await api(`/api/workspaces/${session.workspaceId}/workflows/${workflowId}/run`, { method: "POST", cookie: session.cookie, body: { payload: { ticket: 1 } } });
  assert.equal(started.status, 202, JSON.stringify(started.json));
  await drain("test-worker", 20);
  const waiting = await api(`/api/workspaces/${session.workspaceId}/runs/${started.json.runId}`, { cookie: session.cookie });
  assert.equal(waiting.json.run.status, "waiting", JSON.stringify(waiting.json.run));
  assert.equal(waiting.json.steps.find((step: { nodeId: string }) => step.nodeId === "wait").status, "waiting");
  const canceled = await api(`/api/workspaces/${session.workspaceId}/runs/${started.json.runId}/cancel`, { method: "POST", cookie: session.cookie, body: {} });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.json.run.status, "canceled");
  await drain("test-worker", 20);
  const after = await api(`/api/workspaces/${session.workspaceId}/runs/${started.json.runId}`, { cookie: session.cookie });
  assert.equal(after.json.run.status, "canceled");
  assert.equal(after.json.steps.find((step: { nodeId: string }) => step.nodeId === "done"), undefined);
  assert.match(JSON.stringify(after.json.run.error), /not reversed/i);
});

test("retry repeats a side effect, and an idempotency key dedupes only when the fixture stores it", async () => {
  const session = await owner();
  const charge = (url: string, key?: string) => ({
    schemaVersion: 1,
    name: "Charge",
    description: "",
    settings: { parallelism: 1, runTimeoutMs: 60_000 },
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", config: {} },
      {
        id: "call",
        type: "http_request",
        name: "Charge",
        retry: { maxAttempts: 3, backoffMs: 0, multiplier: 1 },
        config: {
          method: "POST",
          url,
          retryable: true,
          timeoutMs: 5000,
          ...(key ? { idempotencyKeyExpr: { op: "lit", value: key } } : {}),
        },
      },
    ],
    edges: [{ id: "a", source: "start", sourcePort: "out", target: "call", targetPort: "in" }],
  });
  const first = await importAndPublish(session.cookie, session.workspaceId, charge("http://127.0.0.1:4099/charges"));
  const run = await api(`/api/workspaces/${session.workspaceId}/workflows/${first.workflowId}/run`, { method: "POST", cookie: session.cookie, body: { payload: {} } });
  await drain("test-worker", 20);
  const detail = await api(`/api/workspaces/${session.workspaceId}/runs/${run.json.runId}`, { cookie: session.cookie });
  assert.equal(detail.json.run.status, "succeeded", JSON.stringify(detail.json.steps));
  const call = detail.json.steps.find((step: { nodeId: string }) => step.nodeId === "call");
  assert.equal(call.attempt, 2);
  assert.equal(call.output.body.applied, 2);
  const state = await (await fetch("http://127.0.0.1:4099/__state")).json();
  assert.equal(state.charges, 2);

  await fetch("http://127.0.0.1:4099/__reset", { method: "POST" });
  const second = await importAndPublish(session.cookie, session.workspaceId, charge("http://127.0.0.1:4099/charges-idempotent", "charge-key-1"));
  const replay = await api(`/api/workspaces/${session.workspaceId}/workflows/${second.workflowId}/run`, { method: "POST", cookie: session.cookie, body: { payload: {} } });
  await drain("test-worker", 20);
  const replayed = await api(`/api/workspaces/${session.workspaceId}/runs/${replay.json.runId}`, { cookie: session.cookie });
  assert.equal(replayed.json.run.status, "succeeded", JSON.stringify(replayed.json.steps));
  const idempotent = replayed.json.steps.find((step: { nodeId: string }) => step.nodeId === "call");
  assert.equal(idempotent.attempt, 2);
  assert.equal(idempotent.output.body.applied, 1);
  assert.equal(idempotent.output.body.replay, true);
});

test("exported workflow JSON contains the credential reference and not the secret", async () => {
  const session = await owner();
  const encrypted = encryptJson({ value: "super-secret-value" });
  await getPool().query(
    "INSERT INTO credentials (id, workspace_id, name, kind, ciphertext, key_version) VALUES ($1, $2, 'Order hook', 'shared_secret', $3, $4)",
    [EXAMPLE_CREDENTIAL_ID, session.workspaceId, encrypted.ciphertext, encrypted.keyVersion],
  );
  const { workflowId } = await importAndPublish(session.cookie, session.workspaceId, exampleDocuments().intake);
  const exported = await api(`/api/workspaces/${session.workspaceId}/workflows/${workflowId}/export`, { cookie: session.cookie });
  assert.equal(exported.status, 200);
  const text = JSON.stringify(exported.json);
  assert.equal(text.includes("super-secret-value"), false);
  assert.equal(text.includes(encrypted.ciphertext), false);
  assert.equal(text.includes(EXAMPLE_CREDENTIAL_ID), true);
  const leaked = await api(`/api/workspaces/${session.workspaceId}/workflows/import`, {
    method: "POST",
    cookie: session.cookie,
    body: { document: { schemaVersion: 1, name: "Leak", nodes: [], edges: [], password: "super-secret-value" } },
  });
  assert.equal(leaked.status, 400);
  assert.equal(leaked.json.error.code, "invalid_document");
  const script = await api(`/api/workspaces/${session.workspaceId}/workflows/import`, {
    method: "POST",
    cookie: session.cookie,
    body: { document: { schemaVersion: 1, name: "Script", nodes: [{ id: "bad", type: "eval_js", name: "Script", config: {} }], edges: [] } },
  });
  assert.equal(script.status, 400);
});

test("webhook auth, dedup, content type, and rate limit", async () => {
  const session = await owner();
  const encrypted = encryptJson({ value: "hook-secret" });
  await getPool().query(
    "INSERT INTO credentials (id, workspace_id, name, kind, ciphertext, key_version) VALUES ($1, $2, 'Order hook', 'shared_secret', $3, $4)",
    [EXAMPLE_CREDENTIAL_ID, session.workspaceId, encrypted.ciphertext, encrypted.keyVersion],
  );
  const document = exampleDocuments().intake;
  const hook = document.nodes.find((node) => node.id === "hook");
  if (hook?.type === "webhook_trigger") hook.config.rateLimitPerMinute = 4;
  const { workflowId } = await importAndPublish(session.cookie, session.workspaceId, document);
  const detail = await api(`/api/workspaces/${session.workspaceId}/workflows/${workflowId}`, { cookie: session.cookie });
  const token = detail.json.webhook.token as string;
  const missing = await fetch(`${base}/hooks/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: "evt_1", email: "ada@example.com", amount: 10 }) });
  assert.equal(missing.status, 401);
  const wrongType = await fetch(`${base}/hooks/${token}`, { method: "POST", headers: { "content-type": "text/plain", "x-halyard-secret": "hook-secret" }, body: "hello" });
  assert.equal(wrongType.status, 415);
  const accepted = await fetch(`${base}/hooks/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-halyard-secret": "hook-secret" },
    body: JSON.stringify({ eventId: "evt_1", email: "ada@example.com", amount: 10 }),
  });
  assert.equal(accepted.status, 202);
  const first = await accepted.json();
  const duplicate = await fetch(`${base}/hooks/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-halyard-secret": "hook-secret" },
    body: JSON.stringify({ eventId: "evt_1", email: "ada@example.com", amount: 10 }),
  });
  const duplicateBody = await duplicate.json();
  assert.equal(duplicate.status, 200);
  assert.equal(duplicateBody.duplicate, true);
  assert.equal(duplicateBody.runId, first.runId);
  await drain("test-worker", 20);
  const run = await api(`/api/workspaces/${session.workspaceId}/runs/${first.runId}`, { cookie: session.cookie });
  assert.equal(run.json.run.status, "succeeded", JSON.stringify(run.json.steps));
  assert.equal(run.json.steps.find((step: { nodeId: string }) => step.nodeId === "accept").status, "succeeded");
  assert.equal(run.json.steps.find((step: { nodeId: string }) => step.nodeId === "reject").status, "skipped");
  assert.equal(JSON.stringify(run.json).includes("hook-secret"), false);
  const secondEvent = await fetch(`${base}/hooks/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-halyard-secret": "hook-secret" },
    body: JSON.stringify({ eventId: "evt_2", email: "ada@example.com", amount: 10 }),
  });
  assert.equal(secondEvent.status, 202);
  const limited = await fetch(`${base}/hooks/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-halyard-secret": "hook-secret" },
    body: JSON.stringify({ eventId: "evt_3", email: "ada@example.com", amount: 10 }),
  });
  assert.equal(limited.status, 429);
});

test("missed schedules do not backfill, and a due fire cannot dispatch twice", async () => {
  const session = await owner();
  const doc = {
    schemaVersion: 1,
    name: "Clock",
    description: "",
    settings: { parallelism: 1, runTimeoutMs: 60_000 },
    nodes: [
      { id: "clock", type: "schedule_trigger", name: "Clock", config: { cron: "0 6 * * *", timezone: "America/New_York", missedPolicy: "skip" } },
      { id: "done", type: "output", name: "Done", config: { level: "info", message: "fired", classification: "log" } },
    ],
    edges: [{ id: "a", source: "clock", sourcePort: "out", target: "done", targetPort: "in" }],
  };
  const { workflowId } = await importAndPublish(session.cookie, session.workspaceId, doc);
  await getPool().query("UPDATE schedules SET next_fire_at = now() - interval '2 hours' WHERE workflow_id = $1", [workflowId]);
  assert.equal(await fireDueSchedules(), 0);
  const missed = await getPool().query("SELECT count(*)::int AS count FROM runs WHERE workflow_id = $1", [workflowId]);
  assert.equal(missed.rows[0].count, 0);
  await getPool().query("UPDATE schedules SET next_fire_at = now() - interval '5 seconds' WHERE workflow_id = $1", [workflowId]);
  const [first, second] = await Promise.all([fireDueSchedules(), fireDueSchedules()]);
  assert.equal(first + second, 1);
  const runs = await getPool().query("SELECT trigger_payload FROM runs WHERE workflow_id = $1", [workflowId]);
  assert.equal(runs.rowCount, 1);
  assert.equal(runs.rows[0].trigger_payload.missed, false);
  await getPool().query("UPDATE schedules SET missed_policy = 'catch_up_once', next_fire_at = now() - interval '3 hours' WHERE workflow_id = $1", [workflowId]);
  assert.equal(await fireDueSchedules(), 1);
  const caught = await getPool().query("SELECT trigger_payload->>'missed' AS missed FROM runs WHERE workflow_id = $1 ORDER BY created_at DESC LIMIT 1", [workflowId]);
  assert.equal(caught.rows[0].missed, "true");
});

test("viewers cannot read execution payloads, and a stale non-retryable attempt is not repeated", async () => {
  const session = await owner();
  const encrypted = encryptJson({ value: "hook-secret" });
  await getPool().query("INSERT INTO credentials (id, workspace_id, name, kind, ciphertext, key_version) VALUES ($1,$2,'Hook','shared_secret',$3,$4)", [EXAMPLE_CREDENTIAL_ID, session.workspaceId, encrypted.ciphertext, encrypted.keyVersion]);
  const { workflowId } = await importAndPublish(session.cookie, session.workspaceId, exampleDocuments().digest);
  const started = await api(`/api/workspaces/${session.workspaceId}/workflows/${workflowId}/run`, { method: "POST", cookie: session.cookie, body: { payload: {} } });
  await drain("test-worker", 20);
  const viewerUser = await createUser(`view-${session.userId.slice(0, 8)}@halyard.dev`, "Viewer", "halyard-dev-password");
  await getPool().query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')", [session.workspaceId, viewerUser.id]);
  const viewer = await api("/api/auth/login", { method: "POST", body: { email: viewerUser.email, password: "halyard-dev-password" } });
  const hidden = await api(`/api/workspaces/${session.workspaceId}/runs/${started.json.runId}`, { cookie: viewer.cookie });
  assert.equal(hidden.json.run.payloadRestricted, true);
  assert.equal(hidden.json.run.triggerPayload, null);
  assert.equal(hidden.json.steps[0].input, null);
  assert.equal(hidden.json.steps[0].output, null);

  const version = await getPool().query("SELECT published_version_id FROM workflows WHERE id = $1", [workflowId]);
  const run = await getPool().query(
    `INSERT INTO runs (workspace_id, workflow_id, workflow_version_id, status, trigger_type, trigger_payload, deadline_at)
     VALUES ($1, $2, $3, 'running', 'manual', '{}'::jsonb, now() + interval '5 minutes') RETURNING id`,
    [session.workspaceId, workflowId, version.rows[0].published_version_id],
  );
  const step = await getPool().query(
    `INSERT INTO steps (workspace_id, run_id, node_id, node_type, status, attempt)
     VALUES ($1, $2, 'fetch', 'http_request', 'running', 1) RETURNING id`,
    [session.workspaceId, run.rows[0].id],
  );
  await getPool().query(
    `INSERT INTO jobs (workspace_id, run_id, step_id, kind, status, locked_by, locked_until, attempts, payload)
     VALUES ($1, $2, $3, 'execute_step', 'running', 'dead', now() - interval '1 minute', 1, '{"nodeId":"fetch"}'::jsonb)`,
    [session.workspaceId, run.rows[0].id, step.rows[0].id],
  );
  await fetch("http://127.0.0.1:4099/__reset", { method: "POST" });
  await drain("recovery-worker", 10);
  const state = await (await fetch("http://127.0.0.1:4099/__state")).json();
  assert.equal(state.hits, 0);
  const failed = await getPool().query("SELECT status, error->>'code' AS code FROM steps WHERE id = $1", [step.rows[0].id]);
  assert.equal(failed.rows[0].status, "failed");
  assert.equal(failed.rows[0].code, "uncertain_outcome");
});

test("redirects to metadata addresses are blocked", async () => {
  await assert.rejects(safeFetch({ method: "GET", url: "http://127.0.0.1:4099/health", headers: {}, timeoutMs: 2000 }, []), /public destination|blocked/i);
  const session = await owner();
  const doc = {
    schemaVersion: 1,
    name: "Redirect",
    description: "",
    settings: { parallelism: 1, runTimeoutMs: 60_000 },
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", config: {} },
      { id: "call", type: "http_request", name: "Redirect", config: { method: "GET", url: "http://127.0.0.1:4099/redirect-metadata", retryable: false, timeoutMs: 5000 } },
    ],
    edges: [{ id: "a", source: "start", sourcePort: "out", target: "call", targetPort: "in" }],
  };
  const { workflowId } = await importAndPublish(session.cookie, session.workspaceId, doc);
  const started = await api(`/api/workspaces/${session.workspaceId}/workflows/${workflowId}/run`, { method: "POST", cookie: session.cookie, body: { payload: {} } });
  await drain("test-worker", 10);
  const detail = await api(`/api/workspaces/${session.workspaceId}/runs/${started.json.runId}`, { cookie: session.cookie });
  assert.equal(detail.json.run.status, "failed");
  assert.equal(detail.json.steps.find((step: { nodeId: string }) => step.nodeId === "call").error.code, "ssrf_blocked");
});

test("a killed worker leaves a delay queued, and a new worker finishes it once", async () => {
  const session = await owner();
  const doc = {
    schemaVersion: 1,
    name: "Restart",
    description: "",
    settings: { parallelism: 1, runTimeoutMs: 60_000 },
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", config: {} },
      { id: "wait", type: "delay", name: "Wait", config: { durationMs: 1200 } },
      { id: "done", type: "output", name: "Done", config: { level: "info", message: "resumed", classification: "log" } },
    ],
    edges: [
      { id: "a", source: "start", sourcePort: "out", target: "wait", targetPort: "in" },
      { id: "b", source: "wait", sourcePort: "out", target: "done", targetPort: "in" },
    ],
  };
  const { workflowId } = await importAndPublish(session.cookie, session.workspaceId, doc);
  const childEnv = { ...process.env, WORKER_POLL_MS: "80", WORKER_CONCURRENCY: "1", WORKER_ID: "restart-a" };
  const first = spawn("node", ["--import", "tsx", "apps/server/src/worker.ts"], { cwd: "/agent/halyard", env: childEnv, stdio: "ignore" });
  const started = await api(`/api/workspaces/${session.workspaceId}/workflows/${workflowId}/run`, { method: "POST", cookie: session.cookie, body: { payload: { n: 1 } } });
  await waitFor("waiting step", async () => {
    const row = await getPool().query("SELECT status FROM steps WHERE run_id = $1 AND node_id = 'wait'", [started.json.runId]);
    return row.rows[0]?.status === "waiting";
  });
  first.kill("SIGKILL");
  const mid = await getPool().query("SELECT status FROM runs WHERE id = $1", [started.json.runId]);
  assert.equal(mid.rows[0].status, "waiting");
  const queued = await getPool().query("SELECT status, run_at > now() AS future FROM jobs WHERE run_id = $1 AND kind = 'resume_delay'", [started.json.runId]);
  assert.equal(queued.rows[0].status, "queued");
  const second = spawn("node", ["--import", "tsx", "apps/server/src/worker.ts"], {
    cwd: "/agent/halyard",
    env: { ...childEnv, WORKER_ID: "restart-b" },
    stdio: "ignore",
  });
  try {
    await waitFor("restarted run", async () => {
      const row = await getPool().query("SELECT status FROM runs WHERE id = $1", [started.json.runId]);
      return row.rows[0]?.status === "succeeded";
    }, 10000);
  } finally {
    second.kill("SIGKILL");
  }
  const steps = await getPool().query("SELECT node_id, status FROM steps WHERE run_id = $1 ORDER BY node_id", [started.json.runId]);
  assert.deepEqual(steps.rows.map((row) => [row.node_id, row.status]), [
    ["done", "succeeded"],
    ["start", "succeeded"],
    ["wait", "succeeded"],
  ]);
});

test("draft saves conflict when the revision is stale", async () => {
  const session = await owner();
  const created = await api(`/api/workspaces/${session.workspaceId}/workflows`, { method: "POST", cookie: session.cookie, body: { name: "Notes", description: "" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const current = await api(`/api/workspaces/${session.workspaceId}/workflows/${created.json.workflow.id}`, { cookie: session.cookie });
  const document = current.json.draft.document;
  const saved = await api(`/api/workspaces/${session.workspaceId}/workflows/${created.json.workflow.id}/draft`, {
    method: "PUT",
    cookie: session.cookie,
    body: { document, expectedRevision: current.json.draft.revision },
  });
  assert.equal(saved.status, 200);
  const stale = await api(`/api/workspaces/${session.workspaceId}/workflows/${created.json.workflow.id}/draft`, {
    method: "PUT",
    cookie: session.cookie,
    body: { document, expectedRevision: current.json.draft.revision },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "revision_conflict");
});
