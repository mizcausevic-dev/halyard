import {
  LIMITS,
  backoffDelayMs,
  buildContext,
  crashRecovery,
  effectiveRetry,
  executeIterationItem,
  executeNode,
  isTrigger,
  limitStored,
  planGraph,
  redact,
  resolveIterationItems,
  type ItemResult,
  type NodeResult,
  type StepSnapshot,
  type WorkflowDocument,
  type WorkflowNode,
} from "@halyard/core";
import { decryptJson } from "./crypto.js";
import { getPool, isUniqueViolation, withTx, type Db } from "./db.js";
import { loadConfig } from "./env.js";
import { safeFetch } from "./http-out.js";
import { workspaceSecrets } from "./secrets.js";

type RunRow = {
  id: string;
  workspace_id: string;
  workflow_id: string;
  workflow_version_id: string;
  status: string;
  cancel_requested_at: Date | null;
  deadline_at: Date;
  trigger_type: string;
};

type StepRow = {
  id: string;
  run_id: string;
  node_id: string;
  node_type: string;
  status: StepSnapshot["status"];
  attempt: number;
  input: unknown;
  output: unknown;
  error: { code: string; message: string } | null;
  selected_port: string | null;
};

type JobRow = {
  id: string;
  workspace_id: string;
  run_id: string;
  step_id: string;
  kind: "execute_step" | "resume_delay" | "iterate_item";
  attempts: number;
  payload: { nodeId?: string; index?: number };
};

type Loaded = {
  run: RunRow;
  doc: WorkflowDocument;
  steps: StepRow[];
  snapshots: StepSnapshot[];
  triggerOutput: unknown;
};

function store(value: unknown, secrets: readonly string[]): unknown {
  return limitStored(redact(value, secrets), LIMITS.maxStoredOutputBytes).value;
}

function snapshot(row: StepRow): StepSnapshot {
  return {
    nodeId: row.node_id,
    nodeType: row.node_type as WorkflowNode["type"],
    status: row.status,
    input: row.input,
    output: row.output,
    selectedPort: row.selected_port,
    attempt: row.attempt,
    error: row.error,
  };
}

async function loadExecution(client: Db, runId: string, lock: boolean): Promise<Loaded | null> {
  const runResult = await client.query<RunRow>(`SELECT * FROM runs WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [runId]);
  const run = runResult.rows[0];
  if (!run) return null;
  const version = await client.query<{ document: WorkflowDocument }>("SELECT document FROM workflow_versions WHERE id = $1", [run.workflow_version_id]);
  const doc = version.rows[0]?.document;
  if (!doc) return null;
  const stepResult = await client.query<StepRow>("SELECT * FROM steps WHERE run_id = $1 ORDER BY queued_at, node_id", [runId]);
  const graphSteps = stepResult.rows.filter((row) => !row.node_id.includes("@"));
  const trigger = doc.nodes.find((node) => isTrigger(node.type) && !node.iterationParent);
  const triggerStep = graphSteps.find((row) => row.node_id === trigger?.id);
  return {
    run,
    doc,
    steps: stepResult.rows,
    snapshots: graphSteps.map(snapshot),
    triggerOutput: triggerStep?.output ?? null,
  };
}

async function credentialHeader(workspaceId: string, credentialId: string): Promise<Record<string, string>> {
  const result = await getPool().query<{ kind: string; header_name: string | null; ciphertext: string }>(
    "SELECT kind, header_name, ciphertext FROM credentials WHERE id = $1 AND workspace_id = $2",
    [credentialId, workspaceId],
  );
  const row = result.rows[0];
  if (!row) {
    const error = new Error("The credential is not in this workspace.");
    (error as Error & { code: string }).code = "credential_missing";
    throw error;
  }
  const plain = decryptJson(row.ciphertext) as { value?: string; username?: string; password?: string };
  if (row.kind === "bearer") return { Authorization: `Bearer ${plain.value ?? ""}` };
  if (row.kind === "basic") {
    const token = Buffer.from(`${plain.username ?? ""}:${plain.password ?? ""}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }
  if (row.kind === "header") return { [row.header_name || "X-Api-Key"]: plain.value ?? "" };
  return {};
}

async function completeJob(client: Db, jobId: string): Promise<void> {
  await client.query("UPDATE jobs SET status = 'succeeded', finished_at = now(), locked_by = NULL, locked_until = NULL WHERE id = $1", [jobId]);
}

async function enqueue(client: Db, args: {
  workspaceId: string;
  runId: string;
  stepId: string;
  kind: JobRow["kind"];
  runAt?: Date;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await client.query(
      `INSERT INTO jobs (workspace_id, run_id, step_id, kind, status, run_at, payload)
       VALUES ($1, $2, $3, $4, 'queued', COALESCE($5::timestamptz, now()), $6::jsonb)`,
      [args.workspaceId, args.runId, args.stepId, args.kind, args.runAt ?? null, JSON.stringify(args.payload)],
    );
  } catch (error) {
    if (!isUniqueViolation(error, "jobs_one_active_step")) throw error;
  }
}

async function insertStep(client: Db, args: {
  workspaceId: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  status: string;
  attempt?: number;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  selectedPort?: string | null;
  terminal?: boolean;
}): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO steps (
       workspace_id, run_id, node_id, node_type, status, attempt, input, output, error, selected_port, started_at, finished_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10,
       CASE WHEN $5 = 'succeeded' THEN now() ELSE NULL END,
       CASE WHEN $11::boolean THEN now() ELSE NULL END
     )
     ON CONFLICT (run_id, node_id) DO NOTHING
     RETURNING id`,
    [
      args.workspaceId,
      args.runId,
      args.nodeId,
      args.nodeType,
      args.status,
      args.attempt ?? 0,
      args.input === undefined ? null : JSON.stringify(args.input),
      args.output === undefined ? null : JSON.stringify(args.output),
      args.error === undefined ? null : JSON.stringify(args.error),
      args.selectedPort ?? null,
      args.terminal === true,
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function applyPlan(client: Db, loaded: Loaded, secrets: readonly string[]): Promise<void> {
  const plan = planGraph({
    doc: loaded.doc,
    steps: loaded.snapshots,
    cancelRequested: loaded.run.status === "canceled" || Boolean(loaded.run.cancel_requested_at),
  });
  for (const created of plan.create) {
    const id = await insertStep(client, {
      workspaceId: loaded.run.workspace_id,
      runId: loaded.run.id,
      nodeId: created.nodeId,
      nodeType: created.nodeType,
      status: created.status,
      input: store(created.input, secrets),
      output: created.status === "skipped" ? { reason: created.reason ?? "skipped" } : undefined,
      terminal: created.status === "skipped",
    });
    if (created.status === "queued" && id) {
      await enqueue(client, {
        workspaceId: loaded.run.workspace_id,
        runId: loaded.run.id,
        stepId: id,
        kind: "execute_step",
        payload: { nodeId: created.nodeId },
      });
    }
  }
  for (const nodeId of plan.cancel) {
    await client.query("UPDATE steps SET status = 'canceled', finished_at = now() WHERE run_id = $1 AND node_id = $2 AND status IN ('queued', 'waiting')", [loaded.run.id, nodeId]);
    await client.query(
      `UPDATE jobs SET status = 'canceled', finished_at = now()
       WHERE run_id = $1 AND status = 'queued' AND step_id IN (SELECT id FROM steps WHERE run_id = $1 AND node_id = $2)`,
      [loaded.run.id, nodeId],
    );
  }
  if (plan.finish) {
    await client.query(
      `UPDATE runs SET status = $2, finished_at = now(), error = $3::jsonb
       WHERE id = $1 AND status IN ('queued', 'running', 'waiting')`,
      [loaded.run.id, plan.finish.status, plan.finish.message ? JSON.stringify({ code: plan.finish.code ?? plan.finish.status, message: plan.finish.message }) : null],
    );
    return;
  }
  await client.query("UPDATE runs SET status = $2, started_at = COALESCE(started_at, now()) WHERE id = $1 AND status IN ('queued', 'running', 'waiting')", [loaded.run.id, plan.runStatus]);
}

export async function insertRun(client: Db, args: {
  workspaceId: string;
  workflowId: string;
  versionId: string;
  document: WorkflowDocument;
  triggerType: string;
  triggerOutput: unknown;
  scheduleId?: string | null;
  scheduledFor?: Date | null;
  idempotencyKey?: string | null;
  secrets: readonly string[];
}): Promise<{ runId: string; duplicate: boolean }> {
  const trigger = args.document.nodes.find((node) => isTrigger(node.type) && !node.iterationParent);
  if (!trigger) throw new Error("Published workflow is missing a trigger.");
  await client.query("SAVEPOINT create_run");
  try {
    const storedTrigger = store(args.triggerOutput, args.secrets);
    const deadline = new Date(Date.now() + args.document.settings.runTimeoutMs);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO runs (
         workspace_id, workflow_id, workflow_version_id, schedule_id, scheduled_for, status, trigger_type,
         trigger_payload, idempotency_key, deadline_at, started_at
       ) VALUES ($1,$2,$3,$4,$5,'running',$6,$7::jsonb,$8,$9, now())
       RETURNING id`,
      [
        args.workspaceId,
        args.workflowId,
        args.versionId,
        args.scheduleId ?? null,
        args.scheduledFor ?? null,
        args.triggerType,
        JSON.stringify(storedTrigger),
        args.idempotencyKey ?? null,
        deadline,
      ],
    );
    const runId = inserted.rows[0]?.id;
    if (!runId) throw new Error("Run insert did not return an id.");
    await insertStep(client, {
      workspaceId: args.workspaceId,
      runId,
      nodeId: trigger.id,
      nodeType: trigger.type,
      status: "succeeded",
      attempt: 1,
      output: storedTrigger,
      terminal: true,
    });
    const loaded = await loadExecution(client, runId, false);
    if (!loaded) throw new Error("Run disappeared after insert.");
    await applyPlan(client, loaded, args.secrets);
    await client.query("RELEASE SAVEPOINT create_run");
    return { runId, duplicate: false };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT create_run");
    if (!isUniqueViolation(error)) throw error;
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM runs
       WHERE workflow_id = $1
         AND (
           ($2::text IS NOT NULL AND idempotency_key = $2)
           OR ($3::uuid IS NOT NULL AND schedule_id = $3 AND scheduled_for = $4)
         )
       LIMIT 1`,
      [args.workflowId, args.idempotencyKey ?? null, args.scheduleId ?? null, args.scheduledFor ?? null],
    );
    const runId = existing.rows[0]?.id;
    if (!runId) throw error;
    return { runId, duplicate: true };
  }
}

export async function cancelRun(workspaceId: string, runId: string): Promise<RunRow | null> {
  return withTx(async (client) => {
    const result = await client.query<RunRow>("SELECT * FROM runs WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [runId, workspaceId]);
    const run = result.rows[0];
    if (!run) return null;
    if (run.status === "succeeded" || run.status === "failed" || run.status === "canceled") return run;
    await client.query(
      `UPDATE runs SET status = 'canceled', cancel_requested_at = now(), finished_at = now(), error = $2::jsonb WHERE id = $1`,
      [runId, JSON.stringify({ code: "canceled", message: "Run canceled. Completed external actions were not reversed." })],
    );
    await client.query("UPDATE steps SET status = 'canceled', finished_at = now() WHERE run_id = $1 AND status IN ('queued', 'waiting')", [runId]);
    await client.query("UPDATE jobs SET status = 'canceled', finished_at = now() WHERE run_id = $1 AND status = 'queued'", [runId]);
    const updated = await client.query<RunRow>("SELECT * FROM runs WHERE id = $1", [runId]);
    return updated.rows[0] ?? null;
  });
}

export async function reclaimExpired(): Promise<void> {
  await getPool().query("UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL WHERE status = 'running' AND locked_until < now()");
  const capped = await getPool().query<{ id: string; run_id: string; step_id: string }>(
    `UPDATE jobs SET status = 'failed', finished_at = now(), last_error = 'Claim cap reached after repeated worker recovery.'
     WHERE status = 'queued' AND attempts >= max_attempts
     RETURNING id, run_id, step_id`,
  );
  for (const job of capped.rows) {
    await withTx(async (client) => {
      await client.query(
        `UPDATE steps SET status = 'failed', finished_at = now(), error = $2::jsonb
         WHERE id = $1 AND status IN ('queued', 'running', 'waiting')`,
        [job.step_id, JSON.stringify({ code: "job_claim_cap", message: "Worker recovery stopped after the claim cap. An external action may have happened and was not reversed." })],
      );
      const loaded = await loadExecution(client, job.run_id, true);
      if (loaded) await applyPlan(client, loaded, await workspaceSecrets(loaded.run.workspace_id));
    });
  }
}

export async function claimJob(workerId: string): Promise<JobRow | null> {
  const lease = Number(process.env.WORKER_LEASE_MS ?? 30_000);
  const result = await getPool().query<JobRow>(
    `UPDATE jobs SET
       status = 'running',
       locked_by = $1,
       locked_until = now() + make_interval(secs => $2::double precision / 1000.0),
       attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'queued' AND run_at <= now() AND attempts < max_attempts
       ORDER BY run_at, created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [workerId, lease],
  );
  return result.rows[0] ?? null;
}

async function finishJob(jobId: string): Promise<void> {
  await getPool().query("UPDATE jobs SET status = 'succeeded', finished_at = now(), locked_by = NULL, locked_until = NULL WHERE id = $1 AND status = 'running'", [jobId]);
}

export async function handleJob(job: JobRow, workerId: string): Promise<void> {
  const lease = Number(process.env.WORKER_LEASE_MS ?? 30_000);
  const beat = setInterval(() => {
    void getPool().query(
      "UPDATE jobs SET locked_until = now() + make_interval(secs => $2::double precision / 1000.0) WHERE id = $1 AND locked_by = $3 AND status = 'running'",
      [job.id, lease, workerId],
    );
  }, Math.max(1000, Math.floor(lease / 3)));
  try {
    if (job.kind === "resume_delay") await resumeDelay(job);
    else if (job.kind === "iterate_item") await runIterationItem(job);
    else await runStep(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Job failed.";
    await getPool().query("UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL, last_error = $2 WHERE id = $1 AND status = 'running'", [job.id, message.slice(0, 500)]);
    throw error;
  } finally {
    clearInterval(beat);
  }
}

async function runStep(job: JobRow): Promise<void> {
  const decision = await withTx(async (client) => {
    const loaded = await loadExecution(client, job.run_id, true);
    if (!loaded) return { type: "drop" as const };
    const step = loaded.steps.find((entry) => entry.id === job.step_id);
    const node = step ? loaded.doc.nodes.find((entry) => entry.id === step.node_id) : undefined;
    if (!step || !node) return { type: "drop" as const };
    if (loaded.run.status === "canceled" || loaded.run.cancel_requested_at) return { type: "canceled" as const, stepId: step.id };
    if (new Date(loaded.run.deadline_at).getTime() < Date.now()) return { type: "timeout" as const };
    const recovery = crashRecovery(node, snapshot(step));
    if (recovery === "complete") return { type: "drop" as const };
    if (recovery === "uncertain") return { type: "uncertain" as const, stepId: step.id };
    const updated = await client.query<{ attempt: number }>(
      "UPDATE steps SET status = 'running', attempt = attempt + 1, started_at = COALESCE(started_at, now()) WHERE id = $1 RETURNING attempt",
      [step.id],
    );
    await client.query("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1", [job.run_id]);
    return { type: "execute" as const, attempt: updated.rows[0]?.attempt ?? step.attempt + 1, node, step, loaded };
  });

  if (decision.type === "drop") {
    await finishJob(job.id);
    return;
  }
  if (decision.type === "canceled") {
    await withTx(async (client) => {
      await client.query("UPDATE steps SET status = 'canceled', finished_at = COALESCE(finished_at, now()) WHERE id = $1 AND status IN ('queued', 'running', 'waiting')", [decision.stepId]);
      await completeJob(client, job.id);
    });
    return;
  }
  if (decision.type === "timeout") {
    await withTx(async (client) => {
      await client.query(
        "UPDATE runs SET status = 'failed', finished_at = now(), error = $2::jsonb WHERE id = $1 AND status IN ('queued', 'running', 'waiting')",
        [job.run_id, JSON.stringify({ code: "run_timeout", message: "The run exceeded its deadline." })],
      );
      await client.query("UPDATE steps SET status = 'canceled', finished_at = now() WHERE run_id = $1 AND status IN ('queued', 'waiting', 'running') AND id <> $2", [job.run_id, job.step_id]);
      await client.query("UPDATE steps SET status = 'canceled', finished_at = now() WHERE id = $1 AND status IN ('queued', 'running', 'waiting')", [job.step_id]);
      await client.query("UPDATE jobs SET status = 'canceled', finished_at = now() WHERE run_id = $1 AND status = 'queued'", [job.run_id]);
      await completeJob(client, job.id);
    });
    return;
  }
  if (decision.type === "uncertain") {
    await withTx(async (client) => {
      const loaded = await loadExecution(client, job.run_id, true);
      await client.query(
        "UPDATE steps SET status = 'failed', finished_at = now(), error = $2::jsonb WHERE id = $1",
        [decision.stepId, JSON.stringify({ code: "uncertain_outcome", message: "The worker stopped after this non-retryable step started. The external action may have happened. It was not retried and it was not reversed." })],
      );
      if (loaded) await applyPlan(client, await mustLoad(client, job.run_id), await workspaceSecrets(loaded.run.workspace_id));
      await completeJob(client, job.id);
    });
    return;
  }

  const secrets = await workspaceSecrets(decision.loaded.run.workspace_id);
  if (decision.node.type === "iterate") {
    await startIteration(job, decision.node, decision.loaded, secrets);
    return;
  }
  let headers: Record<string, string> = {};
  if (decision.node.type === "http_request" && decision.node.config.credentialId) {
    try {
      headers = await credentialHeader(decision.loaded.run.workspace_id, decision.node.config.credentialId);
    } catch (error) {
      await persistResult(job, decision.node, { status: "failed", error: { code: "credential_missing", message: error instanceof Error ? error.message : "Credential missing." }, retryable: false }, decision.attempt, secrets);
      return;
    }
  }
  const root = buildContext({ doc: decision.loaded.doc, steps: decision.loaded.snapshots, input: decision.step.input, trigger: decision.loaded.triggerOutput });
  const result = await executeNode(decision.node, root, { secrets: { headers }, http: (call) => safeFetch(call, loadConfig().allowHosts) });
  await persistResult(job, decision.node, result, decision.attempt, secrets);
}

async function mustLoad(client: Db, runId: string): Promise<Loaded> {
  const loaded = await loadExecution(client, runId, false);
  if (!loaded) throw new Error(`Run ${runId} disappeared.`);
  return loaded;
}

async function persistResult(job: JobRow, node: WorkflowNode, result: NodeResult, attempt: number, secrets: readonly string[]): Promise<void> {
  await withTx(async (client) => {
    const loaded = await loadExecution(client, job.run_id, true);
    if (!loaded) {
      await completeJob(client, job.id);
      return;
    }
    const step = loaded.steps.find((entry) => entry.id === job.step_id);
    if (!step || step.status === "succeeded" || step.status === "canceled" || step.status === "skipped") {
      await completeJob(client, job.id);
      return;
    }
    const canceled = loaded.run.status === "canceled" || Boolean(loaded.run.cancel_requested_at);
    if (result.status === "waiting") {
      const wake = new Date(Date.now() + result.waitMs);
      await client.query("UPDATE steps SET status = 'waiting', wake_at = $2, input = COALESCE(input, $3::jsonb) WHERE id = $1", [step.id, wake, JSON.stringify(store(result.passthrough, secrets))]);
      await enqueue(client, { workspaceId: job.workspace_id, runId: job.run_id, stepId: step.id, kind: "resume_delay", runAt: wake, payload: {} });
      await completeJob(client, job.id);
      await applyPlan(client, await mustLoad(client, job.run_id), secrets);
      return;
    }
    if (result.status === "failed") {
      const policy = effectiveRetry(node);
      if (!canceled && result.retryable && attempt < policy.maxAttempts) {
        await client.query("UPDATE steps SET status = 'queued', error = $2::jsonb WHERE id = $1", [step.id, JSON.stringify(store(result.error, secrets))]);
        await completeJob(client, job.id);
        await enqueue(client, {
          workspaceId: job.workspace_id,
          runId: job.run_id,
          stepId: step.id,
          kind: "execute_step",
          runAt: new Date(Date.now() + backoffDelayMs(policy, attempt)),
          payload: { nodeId: node.id },
        });
        return;
      }
      await client.query("UPDATE steps SET status = 'failed', finished_at = now(), error = $2::jsonb WHERE id = $1", [step.id, JSON.stringify(store(result.error, secrets))]);
      await completeJob(client, job.id);
      if (!canceled) await applyPlan(client, await mustLoad(client, job.run_id), secrets);
      return;
    }
    await client.query(
      "UPDATE steps SET status = 'succeeded', finished_at = now(), output = $2::jsonb, selected_port = $3, error = NULL WHERE id = $1",
      [step.id, JSON.stringify(store(result.output, secrets)), result.selectedPort ?? null],
    );
    if (node.type === "output") {
      await client.query("INSERT INTO run_logs (run_id, step_id, level, message) VALUES ($1, $2, $3, $4)", [job.run_id, step.id, node.config.level, node.config.message.slice(0, 500)]);
    }
    await completeJob(client, job.id);
    if (!canceled) await applyPlan(client, await mustLoad(client, job.run_id), secrets);
  });
}

async function startIteration(job: JobRow, node: Extract<WorkflowNode, { type: "iterate" }>, loaded: Loaded, secrets: readonly string[]): Promise<void> {
  const root = buildContext({ doc: loaded.doc, steps: loaded.snapshots, input: loaded.steps.find((step) => step.id === job.step_id)?.input, trigger: loaded.triggerOutput });
  const resolved = resolveIterationItems(node, root);
  if ("error" in resolved) {
    await persistResult(job, node, { status: "failed", error: resolved.error, retryable: false }, 1, secrets);
    return;
  }
  const checkpoint = { items: resolved.items, results: [] as ItemResult[] };
  const limited = limitStored(checkpoint, LIMITS.maxStoredOutputBytes);
  if (limited.truncated) {
    await persistResult(job, node, { status: "failed", error: { code: "payload_limit", message: "The iteration input exceeds the stored payload limit." }, retryable: false }, 1, secrets);
    return;
  }
  await withTx(async (client) => {
    if (resolved.items.length === 0) {
      await client.query("UPDATE steps SET status = 'succeeded', finished_at = now(), output = $2::jsonb WHERE id = $1", [job.step_id, JSON.stringify({ count: 0, results: [] })]);
      await completeJob(client, job.id);
      await applyPlan(client, await mustLoad(client, job.run_id), secrets);
      return;
    }
    await client.query("UPDATE steps SET status = 'waiting', output = $2::jsonb WHERE id = $1", [job.step_id, JSON.stringify(store(checkpoint, secrets))]);
    await enqueue(client, { workspaceId: job.workspace_id, runId: job.run_id, stepId: job.step_id, kind: "iterate_item", payload: { index: 0 } });
    await completeJob(client, job.id);
    await client.query("UPDATE runs SET status = 'running' WHERE id = $1 AND status IN ('queued', 'running', 'waiting')", [job.run_id]);
  });
}

async function runIterationItem(job: JobRow): Promise<void> {
  const loaded = await withTx(async (client) => loadExecution(client, job.run_id, true));
  if (!loaded) {
    await finishJob(job.id);
    return;
  }
  const step = loaded.steps.find((entry) => entry.id === job.step_id);
  const node = loaded.doc.nodes.find((entry) => entry.id === step?.node_id);
  if (!step || node?.type !== "iterate") {
    await finishJob(job.id);
    return;
  }
  if (loaded.run.status === "canceled" || loaded.run.cancel_requested_at) {
    await withTx(async (client) => {
      await client.query("UPDATE steps SET status = 'canceled', finished_at = now() WHERE id = $1 AND status IN ('waiting', 'running', 'queued')", [step.id]);
      await completeJob(client, job.id);
    });
    return;
  }
  const checkpoint = (step.output ?? {}) as { items?: unknown[]; results?: ItemResult[] };
  const items = Array.isArray(checkpoint.items) ? checkpoint.items : [];
  const results = Array.isArray(checkpoint.results) ? checkpoint.results : [];
  const index = Number(job.payload.index ?? 0);
  if (results.some((entry) => entry.index === index)) {
    await advanceIteration(job, node, items, results, index, await workspaceSecrets(loaded.run.workspace_id));
    return;
  }
  const prior: Record<string, unknown> = {};
  for (const entry of loaded.snapshots) if (entry.status === "succeeded") prior[entry.nodeId] = entry.output;
  const itemResult = await executeIterationItem({
    doc: loaded.doc,
    iterateNodeId: node.id,
    item: items[index],
    index,
    trigger: loaded.triggerOutput,
    priorNodes: prior,
    hooks: { http: (call) => safeFetch(call, loadConfig().allowHosts) },
  });
  const secrets = await workspaceSecrets(loaded.run.workspace_id);
  await withTx(async (client) => {
    const current = await mustLoad(client, job.run_id);
    const fresh = current.steps.find((entry) => entry.id === step.id);
    const freshCheckpoint = (fresh?.output ?? {}) as { items?: unknown[]; results?: ItemResult[] };
    const freshResults = Array.isArray(freshCheckpoint.results) ? [...freshCheckpoint.results] : [];
    if (freshResults.some((entry) => entry.index === index)) {
      await completeJob(client, job.id);
      return;
    }
    freshResults.push(itemResult);
    for (const body of itemResult.steps) {
      await insertStep(client, {
        workspaceId: job.workspace_id,
        runId: job.run_id,
        nodeId: `${body.nodeId}@${index}`,
        nodeType: body.nodeType,
        status: body.status,
        attempt: body.attempt ?? 1,
        input: store(body.input, secrets),
        output: store(body.output, secrets),
        ...(body.error ? { error: store(body.error, secrets) } : {}),
        selectedPort: body.selectedPort ?? null,
        terminal: body.status !== "queued" && body.status !== "running" && body.status !== "waiting",
      });
    }
    await advanceWithin(client, job, node, Array.isArray(freshCheckpoint.items) ? freshCheckpoint.items : items, freshResults, index, secrets);
  });
}

async function advanceIteration(job: JobRow, node: Extract<WorkflowNode, { type: "iterate" }>, items: unknown[], results: ItemResult[], index: number, secrets: readonly string[]): Promise<void> {
  await withTx(async (client) => {
    await loadExecution(client, job.run_id, true);
    await advanceWithin(client, job, node, items, results, index, secrets);
  });
}

async function advanceWithin(client: Db, job: JobRow, node: Extract<WorkflowNode, { type: "iterate" }>, items: unknown[], results: ItemResult[], index: number, secrets: readonly string[]): Promise<void> {
  const failed = results.find((entry) => entry.index === index && entry.status === "failed");
  const stop = Boolean(failed) && node.config.continueOnError !== true;
  const done = stop || index + 1 >= items.length;
  if (!done) {
    await client.query("UPDATE steps SET status = 'waiting', output = $2::jsonb WHERE id = $1", [job.step_id, JSON.stringify(store({ items, results }, secrets))]);
    await completeJob(client, job.id);
    await enqueue(client, { workspaceId: job.workspace_id, runId: job.run_id, stepId: job.step_id, kind: "iterate_item", payload: { index: index + 1 } });
    return;
  }
  const status = stop ? "failed" : "succeeded";
  await client.query(
    "UPDATE steps SET status = $2, finished_at = now(), output = $3::jsonb, error = $4::jsonb WHERE id = $1",
    [job.step_id, status, JSON.stringify(store({ count: results.length, results }, secrets)), stop ? JSON.stringify(store(failed?.error ?? { code: "iterate_item_failed", message: "An iteration item failed." }, secrets)) : null],
  );
  await completeJob(client, job.id);
  await applyPlan(client, await mustLoad(client, job.run_id), secrets);
}

async function resumeDelay(job: JobRow): Promise<void> {
  await withTx(async (client) => {
    const loaded = await loadExecution(client, job.run_id, true);
    if (!loaded) {
      await completeJob(client, job.id);
      return;
    }
    if (loaded.run.status === "canceled" || loaded.run.cancel_requested_at) {
      await client.query("UPDATE steps SET status = 'canceled', finished_at = now() WHERE id = $1 AND status IN ('waiting', 'queued', 'running')", [job.step_id]);
      await completeJob(client, job.id);
      return;
    }
    await client.query("UPDATE steps SET status = 'succeeded', output = input, finished_at = now(), wake_at = NULL WHERE id = $1", [job.step_id]);
    await completeJob(client, job.id);
    await applyPlan(client, await mustLoad(client, job.run_id), await workspaceSecrets(loaded.run.workspace_id));
  });
}

export async function drain(workerId: string, max = 100): Promise<number> {
  await reclaimExpired();
  let count = 0;
  for (; count < max; count += 1) {
    const job = await claimJob(workerId);
    if (!job) break;
    await handleJob(job, workerId);
  }
  return count;
}
