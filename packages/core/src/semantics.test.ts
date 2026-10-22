import assert from "node:assert/strict";
import test from "node:test";
import { defaultNode } from "./defaults.js";
import { exampleDocuments, ORDER_INVALID, ORDER_SAMPLE } from "./examples.js";
import { evalExpr, parseExpr } from "./expr.js";
import { executeNode, runInMemory, type HttpHandler } from "./execute.js";
import { hasErrors, publishIssues, validateDocument } from "./document.js";
import { connectionIssue } from "./graph.js";
import { crashRecovery } from "./policy.js";
import { nextFireAfter } from "./schedule.js";
import { isPublicAddress } from "./ssrf.js";
import type { WorkflowDocument, WorkflowNode } from "./types.js";

function manual(body: unknown) {
  return { kind: "manual", at: "2026-10-20T12:00:00.000Z", body };
}

function webhook(body: unknown) {
  return { kind: "webhook", at: "2026-10-20T12:00:00.000Z", eventId: (body as { eventId?: string }).eventId ?? null, body };
}

test("expressions reject prototype paths and stay inside limits", () => {
  assert.throws(() => parseExpr({ op: "get", path: "__proto__.polluted" }), /unsupported segment/i);
  assert.throws(() => parseExpr({ op: "eval", code: "1" }), /Unsupported expression op/);
  const root = { input: { body: { email: "Ada@Example.com" } } };
  assert.equal(evalExpr({ op: "lower", arg: { op: "get", path: "input.body.email" } }, root), "ada@example.com");
  assert.equal(evalExpr({ op: "gt", left: { op: "get", path: "missing" }, right: { op: "lit", value: 1 } }, root), false);
  let nested: unknown = { op: "lit", value: 1 };
  for (let i = 0; i < 20; i += 1) nested = { op: "not", arg: nested };
  assert.throws(() => parseExpr(nested));
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("published examples have no semantic errors", () => {
  const examples = exampleDocuments();
  for (const doc of Object.values(examples)) {
    const checked = validateDocument(doc, "publish");
    const errors = checked.issues.filter((issue) => issue.level === "error");
    assert.deepEqual(errors, [], doc.name);
  }
  const intakeWarnings = publishIssues(examples.intake).filter((issue) => issue.level === "warning").map((issue) => issue.code);
  assert.ok(intakeWarnings.includes("private_url"));
});

test("order intake takes one branch and does not call HTTP for an invalid order", async () => {
  const doc = exampleDocuments().intake;
  const calls: string[] = [];
  const http: HttpHandler = async (call) => {
    calls.push(call.url);
    assert.equal(call.headers["Idempotency-Key"], "evt_1001");
    assert.equal(call.body && JSON.parse(call.body).email, "ada@example.com");
    return { status: 200, headers: { "content-type": "application/json" }, body: { accepted: true, id: "ord_1" }, bytes: 24 };
  };
  const accepted = await runInMemory(doc, webhook(ORDER_SAMPLE), { http });
  assert.equal(accepted.status, "succeeded");
  assert.equal(accepted.steps.find((step) => step.nodeId === "accept")?.status, "succeeded");
  assert.equal(accepted.steps.find((step) => step.nodeId === "reject")?.status, "skipped");
  assert.deepEqual(calls, ["http://127.0.0.1:4099/orders/accept"]);

  calls.length = 0;
  const rejected = await runInMemory(doc, webhook(ORDER_INVALID), { http });
  assert.equal(rejected.status, "succeeded");
  assert.equal(rejected.steps.find((step) => step.nodeId === "accept")?.status, "skipped");
  const rejection = rejected.steps.find((step) => step.nodeId === "reject");
  assert.equal(rejection?.status, "succeeded");
  assert.equal((rejection?.output as { classification?: string }).classification, "rejected");
  assert.deepEqual(calls, []);
});

test("scheduled digest maps fixture rows", async () => {
  const doc = exampleDocuments().digest;
  const http: HttpHandler = async () => ({
    status: 200,
    headers: {},
    body: { rows: [{ sku: "INK-4", qty: 3, price: 12 }] },
    bytes: 40,
  });
  const run = await runInMemory(doc, { kind: "schedule", at: "2026-10-20T10:00:00.000Z", scheduledFor: "2026-10-20T10:00:00.000Z", timezone: "America/New_York", cron: "0 6 * * *", missed: false, body: {} }, { http });
  assert.equal(run.status, "succeeded");
  const shape = run.steps.find((step) => step.nodeId === "shape");
  assert.deepEqual((shape?.output as { value: unknown }).value, { count: 1, firstSku: "INK-4" });
});

test("bounded iteration selects one branch per item", async () => {
  const doc = exampleDocuments().batch;
  const payload = (doc.nodes.find((node) => node.id === "start") as Extract<WorkflowNode, { type: "manual_trigger" }>).config.samplePayload;
  const run = await runInMemory(doc, manual(payload));
  assert.equal(run.status, "succeeded");
  const batch = run.steps.find((step) => step.nodeId === "batch");
  const results = (batch?.output as { results: Array<{ steps: Array<{ nodeId: string; status: string }> }> }).results;
  assert.equal(results.length, 3);
  const statusOf = (index: number, nodeId: string) => results[index]?.steps.find((step) => step.nodeId === nodeId)?.status;
  assert.equal(statusOf(0, "approved"), "succeeded");
  assert.equal(statusOf(0, "held"), "skipped");
  assert.equal(statusOf(1, "approved"), "skipped");
  assert.equal(statusOf(1, "held"), "succeeded");
  assert.equal(statusOf(2, "approved"), "succeeded");
  const summary = run.steps.find((step) => step.nodeId === "summary");
  assert.equal(summary?.status, "succeeded");
  assert.equal((summary?.input as { count?: number }).count, 3);
});

test("a cycle cannot be published or connected", () => {
  const doc: WorkflowDocument = {
    schemaVersion: 1,
    name: "Loop",
    description: "",
    settings: { parallelism: 1, runTimeoutMs: 60_000 },
    nodes: [
      defaultNode("manual_trigger", "start", { x: 0, y: 0 }),
      defaultNode("transform", "left", { x: 0, y: 0 }),
      defaultNode("transform", "right", { x: 0, y: 0 }),
    ],
    edges: [
      { id: "a", source: "start", sourcePort: "out", target: "left", targetPort: "in" },
      { id: "b", source: "left", sourcePort: "out", target: "right", targetPort: "in" },
      { id: "c", source: "right", sourcePort: "out", target: "left", targetPort: "in" },
    ],
  };
  const published = validateDocument(doc, "publish");
  assert.equal(hasErrors(published.issues), true);
  assert.ok(published.issues.some((issue) => issue.code === "cycle"));
  const saved = validateDocument(doc, "draft");
  assert.equal(saved.document === null, false);
  const linear = {
    ...doc,
    nodes: doc.nodes.map((node) => (node.id === "left" ? defaultNode("merge", "left", { x: 0, y: 0 }) : node)),
    edges: doc.edges.filter((edge) => edge.id !== "c"),
  };
  assert.equal(connectionIssue(linear, { source: "right", sourcePort: "out", target: "left", targetPort: "in" })?.code, "cycle");
});

test("imports reject secrets and unknown nodes", () => {
  const secret = validateDocument({ schemaVersion: 1, name: "Leak", nodes: [], edges: [], password: "super-secret-value" }, "draft");
  assert.equal(secret.document, null);
  assert.ok(secret.issues.some((issue) => issue.code === "secret_field"));
  const unknown = validateDocument({
    schemaVersion: 1,
    name: "Script",
    nodes: [{ id: "bad", type: "eval_js", name: "Script", config: { code: "process.exit(1)" } }],
    edges: [],
  }, "draft");
  assert.equal(unknown.document, null);
  assert.ok(unknown.issues.some((issue) => issue.code === "unsupported_node"));
  const header = validateDocument({
    schemaVersion: 1,
    name: "Header",
    settings: { parallelism: 1, runTimeoutMs: 60_000 },
    nodes: [{
      id: "call",
      type: "http_request",
      name: "Call",
      config: { method: "GET", url: "https://example.com", headers: [{ name: "Authorization", value: "Bearer super-secret-value" }] },
    }],
    edges: [],
  }, "draft");
  assert.equal(header.document, null);
});

test("merge keeps skipped branches, and first_success fails when none succeeded", async () => {
  const all = defaultNode("merge", "join", { x: 0, y: 0 });
  if (all.type !== "merge") return;
  const kept = await executeNode(all, {
    input: {
      mode: "all",
      branches: [
        { edgeId: "a", nodeId: "yes", status: "succeeded", value: { ok: true } },
        { edgeId: "b", nodeId: "no", status: "skipped", value: null },
      ],
    },
  });
  assert.equal(kept.status, "succeeded");
  const first = defaultNode("merge", "join2", { x: 0, y: 0 });
  if (first.type !== "merge") return;
  first.config.mode = "first_success";
  const none = await executeNode(first, {
    input: { mode: "first_success", branches: [{ edgeId: "b", nodeId: "no", status: "skipped", value: null }] },
  });
  assert.equal(none.status, "failed");
  if (none.status === "failed") assert.equal(none.error.code, "merge_none_succeeded");
});

test("non-retryable HTTP is not repeated, retryable HTTP is", async () => {
  const once = defaultNode("http_request", "call", { x: 0, y: 0 });
  if (once.type !== "http_request") return;
  once.config = { method: "POST", url: "https://example.com/charges", retryable: false };
  let hits = 0;
  const http: HttpHandler = async () => {
    hits += 1;
    return { status: 500, headers: {}, body: { applied: hits }, bytes: 12 };
  };
  const doc: WorkflowDocument = {
    schemaVersion: 1,
    name: "Charge",
    description: "",
    settings: { parallelism: 1, runTimeoutMs: 60_000 },
    nodes: [defaultNode("manual_trigger", "start", { x: 0, y: 0 }), once, defaultNode("output", "done", { x: 0, y: 0 })],
    edges: [
      { id: "a", source: "start", sourcePort: "out", target: "call", targetPort: "in" },
      { id: "b", source: "call", sourcePort: "out", target: "done", targetPort: "in" },
    ],
  };
  const failed = await runInMemory(doc, manual({}), { http });
  assert.equal(failed.status, "failed");
  assert.equal(hits, 1);
  assert.equal(failed.steps.find((step) => step.nodeId === "done")?.status, undefined);

  once.config.retryable = true;
  once.retry = { maxAttempts: 3, backoffMs: 1, multiplier: 1 };
  hits = 0;
  const httpRetry: HttpHandler = async () => {
    hits += 1;
    if (hits < 2) return { status: 500, headers: {}, body: { applied: hits }, bytes: 12 };
    return { status: 200, headers: {}, body: { applied: hits }, bytes: 12 };
  };
  const retried = await runInMemory(doc, manual({}), { http: httpRetry });
  assert.equal(retried.status, "succeeded");
  assert.equal(hits, 2);
  assert.equal(retried.steps.find((step) => step.nodeId === "call")?.attempt, 2);
});

test("crash recovery does not re-execute a spent non-retryable attempt", () => {
  const http = defaultNode("http_request", "call", { x: 0, y: 0 });
  assert.equal(crashRecovery(http, { nodeId: "call", nodeType: "http_request", status: "running", attempt: 1 }), "uncertain");
  assert.equal(crashRecovery(http, { nodeId: "call", nodeType: "http_request", status: "succeeded", attempt: 1 }), "complete");
  const pure = defaultNode("transform", "shape", { x: 0, y: 0 });
  assert.equal(crashRecovery(pure, { nodeId: "shape", nodeType: "transform", status: "running", attempt: 1 }), "execute");
  const delay = defaultNode("delay", "wait", { x: 0, y: 0 });
  assert.equal(crashRecovery(delay, { nodeId: "wait", nodeType: "delay", status: "waiting", attempt: 1 }), "complete");
});

test("schedule wrapper matches observed daylight-saving instants", () => {
  assert.equal(nextFireAfter("30 2 * * *", "America/New_York", new Date("2026-03-07T12:00:00Z")).toISOString(), "2026-03-08T07:30:00.000Z");
  assert.equal(nextFireAfter("30 2 * * *", "America/New_York", new Date("2026-03-08T07:30:00.000Z")).toISOString(), "2026-03-09T06:30:00.000Z");
  assert.equal(nextFireAfter("30 1 * * *", "America/New_York", new Date("2026-11-01T04:00:00Z")).toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(nextFireAfter("30 1 * * *", "America/New_York", new Date("2026-11-01T05:30:00.000Z")).toISOString(), "2026-11-02T06:30:00.000Z");
  assert.equal(nextFireAfter("30 1 * * *", "America/New_York", new Date("2026-11-01T06:15:00.000Z")).toISOString(), "2026-11-02T06:30:00.000Z");
});

test("public address classification blocks private and metadata ranges", () => {
  assert.equal(isPublicAddress("8.8.8.8"), true);
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "fe80::1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress("::ffff:127.0.0.1"), false);
  assert.equal(isPublicAddress("2001:4860:4860::8888"), true);
});
