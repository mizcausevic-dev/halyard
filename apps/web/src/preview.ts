import {
  exampleDocuments,
  hasErrors,
  publishIssues,
  runInMemory,
  validateDocument,
  type HttpHandler,
  type WorkflowDocument,
} from "@halyard/core";

const WORKSPACE = "00000000-0000-4000-8000-0000000000aa";
const now = "2026-10-20T15:00:00.000Z";

type WorkflowRecord = {
  id: string;
  name: string;
  slug: string;
  description: string;
  updated_at: string;
  published_version_id: string | null;
  draftRevision: number;
  draft: WorkflowDocument;
  published: WorkflowDocument | null;
  publishedVersion: number;
};

type RunRecord = {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersionId: string;
  versionNumber: number;
  status: string;
  triggerType: string;
  triggerPayload: unknown;
  error: unknown;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  deadlineAt: string;
  scheduledFor: string | null;
  cancelRequestedAt: string | null;
  steps: Array<Record<string, unknown>>;
  document: WorkflowDocument;
};

const http: HttpHandler = async (call) => {
  if (call.url.endsWith("/orders/accept")) {
    const body = call.body ? JSON.parse(call.body) : {};
    return { status: 200, headers: { "content-type": "application/json" }, body: { accepted: true, id: "ord_preview", ...body }, bytes: 32 };
  }
  if (call.url.endsWith("/reports/daily")) {
    return { status: 200, headers: { "content-type": "application/json" }, body: { rows: [{ sku: "INK-4", qty: 3, price: 12 }] }, bytes: 40 };
  }
  return { status: 599, headers: { "content-type": "application/json" }, body: { error: "The preview runner does not open network connections." }, bytes: 16 };
};

function seedWorkflow(id: string, slug: string, document: WorkflowDocument): WorkflowRecord {
  return {
    id,
    name: document.name,
    slug,
    description: document.description,
    updated_at: now,
    published_version_id: `${id}-v1`,
    draftRevision: 1,
    draft: structuredClone(document),
    published: structuredClone(document),
    publishedVersion: 1,
  };
}

const examples = exampleDocuments();
const workflows = new Map<string, WorkflowRecord>([
  ["wf-intake", seedWorkflow("wf-intake", "order-intake", examples.intake)],
  ["wf-digest", seedWorkflow("wf-digest", "morning-digest", examples.digest)],
  ["wf-batch", seedWorkflow("wf-batch", "amount-split", examples.batch)],
]);
const runs: RunRecord[] = [];
const credentials = [
  { id: "00000000-0000-4000-8000-0000000000c1", name: "Order webhook", kind: "shared_secret", header_name: null, key_version: 1, created_at: now, updated_at: now },
];
const members = [{ id: "user-ada", email: "ada@halyard.dev", name: "Ada Quartermain", role: "owner", created_at: now }];
let signedIn = false;

function workflowJson(record: WorkflowRecord) {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    description: record.description,
    updated_at: record.updated_at,
    published_version_id: record.published_version_id,
    draft_revision: record.draftRevision,
    published_version: record.published ? record.publishedVersion : null,
  };
}

function presentRun(run: RunRecord) {
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    workflowVersionId: run.workflowVersionId,
    versionNumber: run.versionNumber,
    status: run.status,
    triggerType: run.triggerType,
    triggerPayload: run.triggerPayload,
    payloadRestricted: false,
    error: run.error,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    deadlineAt: run.deadlineAt,
    scheduledFor: run.scheduledFor,
    cancelRequestedAt: run.cancelRequestedAt,
  };
}

export async function previewApi<T>(path: string, init: { method?: string; body?: unknown }): Promise<{ status: number; body: T }> {
  const method = init.method ?? "GET";
  const body = (init.body ?? {}) as Record<string, unknown>;
  const fail = (status: number, code: string, message: string, details?: unknown) => ({ status, body: { error: { code, message, details: details ?? null } } as T });
  if (method === "POST" && path === "/api/auth/login") {
    if (String(body.email).toLowerCase() === "ada@halyard.dev" && body.password === "halyard-dev-password") {
      signedIn = true;
      return { status: 200, body: { user: { id: "user-ada", email: "ada@halyard.dev", name: "Ada Quartermain" } } as T };
    }
    return fail(401, "invalid_login", "Email or password is wrong.");
  }
  if (method === "POST" && path === "/api/auth/logout") {
    signedIn = false;
    return { status: 200, body: { ok: true } as T };
  }
  if (!signedIn) return fail(401, "unauthenticated", "Sign in required.");
  if (method === "GET" && path === "/api/me") {
    return { status: 200, body: { user: members[0], workspaces: [{ id: WORKSPACE, name: "Studio", slug: "studio", role: "owner" }] } as T };
  }
  const workspace = path.match(/^\/api\/workspaces\/([^/]+)(.*)$/);
  if (!workspace || workspace[1] !== WORKSPACE) return fail(404, "not_found", "Workspace not found.");
  const rest = workspace[2] ?? "";
  if (method === "GET" && rest === "/dashboard") {
    const counts = new Map<string, number>();
    for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
    return {
      status: 200,
      body: {
        workflowCount: workflows.size,
        runCounts: [...counts.entries()].map(([status, count]) => ({ status, count })),
        recentRuns: runs.slice(-8).reverse().map(presentRun),
        schedules: [...workflows.values()].filter((item) => item.published?.nodes.some((node) => node.type === "schedule_trigger")).map((item) => ({
          id: item.id,
          workflow_id: item.id,
          workflow_name: item.name,
          cron: "0 6 * * *",
          timezone: "America/New_York",
          missed_policy: "skip",
          next_fire_at: now,
          enabled: true,
        })),
      } as T,
    };
  }
  if (rest === "/workflows" && method === "GET") return { status: 200, body: { workflows: [...workflows.values()].map(workflowJson) } as T };
  if (rest === "/workflows" && method === "POST") {
    const id = crypto.randomUUID();
    const document: WorkflowDocument = {
      schemaVersion: 1,
      name: String(body.name ?? "Untitled"),
      description: String(body.description ?? ""),
      settings: { parallelism: 4, runTimeoutMs: 300_000 },
      nodes: [{ id: "start", type: "manual_trigger", name: "Manual trigger", position: { x: 48, y: 72 }, config: { samplePayload: {} } }],
      edges: [],
    };
    workflows.set(id, seedWorkflow(id, id.slice(0, 8), document));
    workflows.get(id)!.published = null;
    workflows.get(id)!.published_version_id = null;
    return { status: 201, body: { workflow: workflowJson(workflows.get(id)!), draft: { revision: 1 }, document } as T };
  }
  if (rest === "/workflows/import" && method === "POST") {
    const checked = validateDocument(body.document, "draft");
    if (!checked.document || hasErrors(checked.issues)) return fail(400, "invalid_document", "The workflow document was rejected.", checked.issues);
    const id = crypto.randomUUID();
    const record = seedWorkflow(id, checked.document.name.toLowerCase().replace(/\s+/g, "-"), checked.document);
    record.published = null;
    record.published_version_id = null;
    workflows.set(id, record);
    return { status: 201, body: { workflow: workflowJson(record), draft: { revision: 1 } } as T };
  }
  const workflowMatch = rest.match(/^\/workflows\/([^/]+)(.*)$/);
  if (workflowMatch) {
    const record = workflows.get(workflowMatch[1] ?? "");
    if (!record) return fail(404, "not_found", "Workflow not found.");
    const tail = workflowMatch[2] ?? "";
    if (method === "GET" && tail === "") {
      return {
        status: 200,
        body: {
          workflow: workflowJson(record),
          draft: { id: `${record.id}-draft`, revision: record.draftRevision, document: record.draft },
          webhook: record.published?.nodes.some((node) => node.type === "webhook_trigger") ? { token: "preview-token", auth_mode: "shared_secret", enabled: true, rate_limit_per_minute: 30, event_id_path: "eventId", secret_header: "X-Halyard-Secret" } : null,
          schedule: record.published?.nodes.some((node) => node.type === "schedule_trigger") ? { cron: "0 6 * * *", timezone: "America/New_York", missed_policy: "skip", next_fire_at: now, enabled: true } : null,
        } as T,
      };
    }
    if (method === "PUT" && tail === "/draft") {
      const checked = validateDocument(body.document, "draft");
      if (!checked.document || hasErrors(checked.issues)) return fail(400, "invalid_document", "The workflow document was rejected.", checked.issues);
      if (body.expectedRevision !== record.draftRevision) return fail(409, "revision_conflict", "This draft changed since you loaded it.", { revision: record.draftRevision });
      record.draft = checked.document;
      record.name = checked.document.name;
      record.description = checked.document.description;
      record.draftRevision += 1;
      record.updated_at = new Date().toISOString();
      return { status: 200, body: { revision: record.draftRevision, document: record.draft } as T };
    }
    if (method === "POST" && tail === "/publish") {
      const issues = publishIssues(record.draft);
      if (hasErrors(issues)) return fail(400, "publish_invalid", "This draft cannot be published.", issues);
      record.published = structuredClone(record.draft);
      record.publishedVersion += record.published_version_id ? 1 : 1;
      record.published_version_id = `${record.id}-v${record.publishedVersion}`;
      return { status: 200, body: { versionId: record.published_version_id, versionNumber: record.publishedVersion, warnings: issues.filter((issue) => issue.level === "warning") } as T };
    }
    if (method === "GET" && tail === "/versions") {
      const versions: Array<Record<string, unknown>> = [{ id: `${record.id}-draft`, version_number: 0, status: "draft", revision: record.draftRevision, published_at: null, created_at: now, document: record.draft }];
      if (record.published && record.published_version_id) versions.push({ id: record.published_version_id, version_number: record.publishedVersion, status: "published", revision: 1, published_at: now, created_at: now, document: record.published });
      return { status: 200, body: { versions } as T };
    }
    if (method === "GET" && tail === "/export") {
      const document = record.published ?? record.draft;
      return { status: 200, body: { document } as T };
    }
    if (method === "POST" && tail === "/run") {
      if (!record.published || !record.published_version_id) return fail(409, "unpublished", "Publish the workflow before running it.");
      const payload = body.payload ?? {};
      const trigger = record.published.nodes.find((node) => node.type.endsWith("trigger"));
      const triggerOutput = trigger?.type === "webhook_trigger"
        ? { kind: "webhook", at: new Date().toISOString(), eventId: null, manualRun: true, body: payload }
        : trigger?.type === "schedule_trigger"
          ? { kind: "schedule", at: new Date().toISOString(), scheduledFor: new Date().toISOString(), timezone: trigger.config.timezone, cron: trigger.config.cron, missed: false, manualRun: true, body: payload }
          : { kind: "manual", at: new Date().toISOString(), body: payload };
      const result = await runInMemory(record.published, triggerOutput, { http });
      const id = crypto.randomUUID();
      const stamped = new Date().toISOString();
      const steps: Array<Record<string, unknown>> = [];
      for (const step of result.steps) {
        steps.push({
          id: `${id}-${step.nodeId}`,
          nodeId: step.nodeId,
          nodeType: step.nodeType,
          status: step.status,
          attempt: step.attempt ?? 0,
          selectedPort: step.selectedPort ?? null,
          input: step.input ?? null,
          output: step.output ?? null,
          error: step.error ?? null,
          queuedAt: stamped,
          startedAt: stamped,
          finishedAt: stamped,
          wakeAt: null,
          payloadRestricted: false,
        });
        const results = (step.output as { results?: Array<{ index: number; steps: Array<Record<string, unknown>> }> } | undefined)?.results;
        if (step.nodeType === "iterate" && results) {
          for (const item of results) {
            for (const bodyStep of item.steps) {
              steps.push({
                id: `${id}-${bodyStep.nodeId}@${item.index}`,
                nodeId: `${bodyStep.nodeId}@${item.index}`,
                nodeType: bodyStep.nodeType,
                status: bodyStep.status,
                attempt: bodyStep.attempt ?? 1,
                selectedPort: bodyStep.selectedPort ?? null,
                input: bodyStep.input ?? null,
                output: bodyStep.output ?? null,
                error: bodyStep.error ?? null,
                queuedAt: stamped,
                startedAt: stamped,
                finishedAt: stamped,
                wakeAt: null,
                payloadRestricted: false,
              });
            }
          }
        }
      }
      runs.push({
        id,
        workflowId: record.id,
        workflowName: record.name,
        workflowVersionId: record.published_version_id,
        versionNumber: record.publishedVersion,
        status: result.status,
        triggerType: trigger?.type === "webhook_trigger" ? "webhook" : trigger?.type === "schedule_trigger" ? "schedule" : "manual",
        triggerPayload: triggerOutput,
        error: result.status === "failed" ? { code: "step_failed", message: "A step failed. Preview runs do not leave the browser." } : null,
        queuedAt: stamped,
        startedAt: stamped,
        finishedAt: stamped,
        deadlineAt: stamped,
        scheduledFor: null,
        cancelRequestedAt: null,
        steps,
        document: record.published,
      });
      return { status: 202, body: { runId: id, duplicate: false, preview: true } as T };
    }
  }
  if (method === "GET" && rest === "/runs") {
    return { status: 200, body: { runs: [...runs].reverse().map(presentRun) } as T };
  }
  const runMatch = rest.match(/^\/runs\/([^/]+)$/);
  if (runMatch && method === "GET") {
    const run = runs.find((item) => item.id === runMatch[1]);
    if (!run) return fail(404, "not_found", "Run not found.");
    return { status: 200, body: { run: presentRun(run), steps: run.steps, logs: [], document: run.document } as T };
  }
  if (method === "POST" && rest.endsWith("/cancel")) {
    const id = rest.split("/")[2];
    const run = runs.find((item) => item.id === id);
    if (!run) return fail(404, "not_found", "Run not found.");
    if (run.status === "waiting" || run.status === "running" || run.status === "queued") {
      run.status = "canceled";
      run.error = { code: "canceled", message: "Run canceled. Completed external actions were not reversed." };
    }
    return { status: 200, body: { run: presentRun(run) } as T };
  }
  if (rest === "/credentials" && method === "GET") return { status: 200, body: { credentials } as T };
  if (rest === "/credentials" && method === "POST") {
    const created = { id: crypto.randomUUID(), name: String(body.name ?? "Credential"), kind: String(body.kind ?? "bearer"), header_name: null, key_version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    credentials.push(created);
    return { status: 201, body: { credential: created } as T };
  }
  if (rest === "/hooks" && method === "GET") {
    return { status: 200, body: { hooks: [...workflows.values()].filter((item) => item.published?.nodes.some((node) => node.type === "webhook_trigger")).map((item) => ({ id: item.id, workflow_id: item.id, workflow_name: item.name, token: "preview-token", path: "/hooks/preview-token", auth_mode: "shared_secret", enabled: true, rate_limit_per_minute: 30, event_id_path: "eventId", secret_header: "X-Halyard-Secret" })) } as T };
  }
  if (rest === "/schedules" && method === "GET") {
    return { status: 200, body: { schedules: [...workflows.values()].filter((item) => item.published?.nodes.some((node) => node.type === "schedule_trigger")).map((item) => ({ id: item.id, workflow_id: item.id, workflow_name: item.name, cron: "0 6 * * *", timezone: "America/New_York", missed_policy: "skip", next_fire_at: now, enabled: true })) } as T };
  }
  if (rest === "/members" && method === "GET") return { status: 200, body: { members } as T };
  if (rest === "/members" && method === "POST") {
    members.push({ id: crypto.randomUUID(), email: String(body.email ?? ""), name: String(body.name ?? ""), role: String(body.role ?? "viewer"), created_at: new Date().toISOString() });
    return { status: 201, body: { member: members[members.length - 1], passwordOnce: String(body.password ?? "") } as T };
  }
  return fail(404, "not_found", "This preview route is not implemented.");
}
