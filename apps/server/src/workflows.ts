import { randomBytes } from "node:crypto";
import {
  defaultNode,
  hasErrors,
  isTrigger,
  nextFireAfter,
  publishIssues,
  validateDocument,
  type WorkflowDocument,
} from "@halyard/core";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";

function emptyDraft(name: string, description: string): WorkflowDocument {
  return {
    schemaVersion: 1,
    name,
    description,
    settings: { parallelism: 4, runTimeoutMs: 300_000 },
    nodes: [defaultNode("manual_trigger", "start", { x: 48, y: 72 })],
    edges: [],
  };
}

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return base || "workflow";
}

async function uniqueSlug(client: Db, workspaceId: string, name: string): Promise<string> {
  const base = slugify(name);
  for (let index = 0; index < 30; index += 1) {
    const slug = index === 0 ? base : `${base}-${index + 1}`;
    const existing = await client.query("SELECT 1 FROM workflows WHERE workspace_id = $1 AND slug = $2", [workspaceId, slug]);
    if (existing.rowCount === 0) return slug;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}

function assertDraft(input: unknown): WorkflowDocument {
  const checked = validateDocument(input, "draft");
  if (!checked.document || hasErrors(checked.issues)) {
    throw new ApiError(400, "invalid_document", "The workflow document was rejected.", checked.issues);
  }
  return checked.document;
}

export async function createWorkflow(client: Db, workspaceId: string, name: string, description = "", source?: unknown) {
  const document = source === undefined ? emptyDraft(name, description) : assertDraft(source);
  if (source === undefined) {
    document.name = name;
    document.description = description;
  }
  const slug = await uniqueSlug(client, workspaceId, document.name);
  const workflow = await client.query(
    "INSERT INTO workflows (workspace_id, name, slug, description) VALUES ($1, $2, $3, $4) RETURNING *",
    [workspaceId, document.name, slug, document.description],
  );
  const version = await client.query(
    `INSERT INTO workflow_versions (workflow_id, workspace_id, version_number, status, schema_version, document, revision)
     VALUES ($1, $2, 0, 'draft', 1, $3::jsonb, 1) RETURNING id, revision`,
    [workflow.rows[0].id, workspaceId, JSON.stringify(document)],
  );
  return { workflow: workflow.rows[0], draft: version.rows[0], document };
}

export async function saveDraft(client: Db, workspaceId: string, workflowId: string, input: unknown, expectedRevision: number) {
  const document = assertDraft(input);
  const updated = await client.query<{ id: string; revision: number }>(
    `UPDATE workflow_versions
     SET document = $1::jsonb, revision = revision + 1
     WHERE workflow_id = $2 AND workspace_id = $3 AND status = 'draft' AND revision = $4
     RETURNING id, revision`,
    [JSON.stringify(document), workflowId, workspaceId, expectedRevision],
  );
  const row = updated.rows[0];
  if (!row) {
    const current = await client.query<{ revision: number }>("SELECT revision FROM workflow_versions WHERE workflow_id = $1 AND workspace_id = $2 AND status = 'draft'", [workflowId, workspaceId]);
    throw new ApiError(409, "revision_conflict", "This draft changed since you loaded it. Reload the server copy, or overwrite it explicitly.", {
      revision: current.rows[0]?.revision ?? null,
    });
  }
  await client.query("UPDATE workflows SET name = $2, description = $3, updated_at = now() WHERE id = $1 AND workspace_id = $4", [workflowId, document.name, document.description, workspaceId]);
  return { revision: row.revision, document };
}

async function assertCredentials(client: Db, workspaceId: string, document: WorkflowDocument): Promise<void> {
  const ids = new Set<string>();
  for (const node of document.nodes) {
    if ((node.type === "webhook_trigger" || node.type === "http_request") && node.config.credentialId) ids.add(node.config.credentialId);
  }
  for (const id of ids) {
    const found = await client.query("SELECT 1 FROM credentials WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
    if (found.rowCount === 0) throw new ApiError(400, "credential_missing", "A referenced credential is not in this workspace.");
  }
}

async function syncTriggers(client: Db, workspaceId: string, workflowId: string, document: WorkflowDocument): Promise<void> {
  const trigger = document.nodes.find((node) => isTrigger(node.type) && !node.iterationParent);
  if (trigger?.type === "schedule_trigger") {
    const next = nextFireAfter(trigger.config.cron, trigger.config.timezone, new Date());
    await client.query(
      `INSERT INTO schedules (workspace_id, workflow_id, cron, timezone, missed_policy, next_fire_at, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (workflow_id) DO UPDATE
         SET cron = EXCLUDED.cron, timezone = EXCLUDED.timezone, missed_policy = EXCLUDED.missed_policy,
             next_fire_at = EXCLUDED.next_fire_at, enabled = true, updated_at = now()`,
      [workspaceId, workflowId, trigger.config.cron, trigger.config.timezone, trigger.config.missedPolicy, next],
    );
    await client.query("UPDATE webhook_endpoints SET enabled = false WHERE workflow_id = $1", [workflowId]);
    return;
  }
  if (trigger?.type === "webhook_trigger") {
    const existing = await client.query<{ token: string }>("SELECT token FROM webhook_endpoints WHERE workflow_id = $1", [workflowId]);
    const token = existing.rows[0]?.token ?? randomBytes(24).toString("base64url");
    await client.query(
      `INSERT INTO webhook_endpoints (
         workspace_id, workflow_id, token, auth_mode, credential_id, secret_header, signature_header, event_id_path, rate_limit_per_minute, enabled
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
       ON CONFLICT (workflow_id) DO UPDATE SET
         auth_mode = EXCLUDED.auth_mode,
         credential_id = EXCLUDED.credential_id,
         secret_header = EXCLUDED.secret_header,
         signature_header = EXCLUDED.signature_header,
         event_id_path = EXCLUDED.event_id_path,
         rate_limit_per_minute = EXCLUDED.rate_limit_per_minute,
         enabled = true`,
      [
        workspaceId,
        workflowId,
        token,
        trigger.config.authMode,
        trigger.config.credentialId ?? null,
        trigger.config.secretHeader ?? "X-Halyard-Secret",
        trigger.config.signatureHeader ?? "X-Halyard-Signature",
        trigger.config.eventIdPath ?? null,
        trigger.config.rateLimitPerMinute ?? 60,
      ],
    );
    await client.query("UPDATE schedules SET enabled = false WHERE workflow_id = $1", [workflowId]);
    return;
  }
  await client.query("UPDATE schedules SET enabled = false WHERE workflow_id = $1", [workflowId]);
  await client.query("UPDATE webhook_endpoints SET enabled = false WHERE workflow_id = $1", [workflowId]);
}

export async function publishWorkflow(client: Db, workspaceId: string, workflowId: string) {
  const draft = await client.query<{ document: WorkflowDocument }>(
    "SELECT document FROM workflow_versions WHERE workflow_id = $1 AND workspace_id = $2 AND status = 'draft' FOR UPDATE",
    [workflowId, workspaceId],
  );
  const document = draft.rows[0]?.document;
  if (!document) throw new ApiError(404, "not_found", "Draft not found.");
  const issues = publishIssues(document);
  if (hasErrors(issues)) throw new ApiError(400, "publish_invalid", "This draft cannot be published.", issues);
  await assertCredentials(client, workspaceId, document);
  const next = await client.query<{ n: number }>("SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM workflow_versions WHERE workflow_id = $1 AND status = 'published'", [workflowId]);
  const versionNumber = Number(next.rows[0]?.n ?? 1);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO workflow_versions (workflow_id, workspace_id, version_number, status, schema_version, document, revision, published_at)
     VALUES ($1, $2, $3, 'published', 1, $4::jsonb, 1, now()) RETURNING id`,
    [workflowId, workspaceId, versionNumber, JSON.stringify(document)],
  );
  const versionId = inserted.rows[0]?.id;
  if (!versionId) throw new Error("Publish did not return a version.");
  await client.query("UPDATE workflows SET published_version_id = $2, name = $3, description = $4, updated_at = now() WHERE id = $1", [workflowId, versionId, document.name, document.description]);
  await syncTriggers(client, workspaceId, workflowId, document);
  return { versionId, versionNumber, warnings: issues.filter((issue) => issue.level === "warning"), document };
}

export async function restoreVersion(client: Db, workspaceId: string, workflowId: string, versionId: string, expectedRevision: number) {
  const version = await client.query<{ document: WorkflowDocument }>(
    "SELECT document FROM workflow_versions WHERE id = $1 AND workflow_id = $2 AND workspace_id = $3 AND status = 'published'",
    [versionId, workflowId, workspaceId],
  );
  const document = version.rows[0]?.document;
  if (!document) throw new ApiError(404, "not_found", "Published version not found.");
  return saveDraft(client, workspaceId, workflowId, document, expectedRevision);
}
