import { ExprError, evalExpr } from "./expr.js";
import { LIMITS } from "./limits.js";
import { planGraph, buildContext, type PlanScope } from "./plan.js";
import { backoffDelayMs, effectiveRetry } from "./policy.js";
import { redact } from "./redact.js";
import { isTrigger, type Expr, type RunStatus, type StepSnapshot, type WorkflowDocument, type WorkflowNode } from "./types.js";

export type HttpCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type HttpResult = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bytes: number;
  truncated?: boolean;
};

export type HttpHandler = (call: HttpCall) => Promise<HttpResult>;

export type NodeResult =
  | { status: "succeeded"; output: unknown; selectedPort?: string }
  | { status: "waiting"; waitMs: number; passthrough: unknown }
  | { status: "failed"; error: { code: string; message: string }; retryable: boolean };

export type ExecuteHooks = {
  http?: HttpHandler;
  signal?: AbortSignal;
  secrets?: { headers?: Record<string, string> };
};

function failed(code: string, message: string, retryable = false): NodeResult {
  return { status: "failed", error: { code, message }, retryable };
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function evalOrFail(expr: Expr, root: unknown): { ok: true; value: unknown } | { ok: false; result: NodeResult } {
  try {
    return { ok: true, value: evalExpr(expr, root) };
  } catch (error) {
    if (error instanceof ExprError) return { ok: false, result: failed(error.code, error.message) };
    return { ok: false, result: failed("expr_failed", "Expression failed.") };
  }
}

function applyTransform(input: unknown, node: Extract<WorkflowNode, { type: "transform" }>, root: Record<string, unknown>): NodeResult {
  const current = readObject(input);
  if (!current) return failed("transform_input", "Transform expects an object input.");
  const draft: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
    draft[key] = value;
  }
  for (const step of node.config.steps) {
    if (step.op === "pick") {
      for (const key of Object.keys(draft)) if (!step.keys.includes(key)) delete draft[key];
    } else if (step.op === "drop") {
      for (const key of step.keys) delete draft[key];
    } else if (step.op === "rename") {
      if (Object.prototype.hasOwnProperty.call(draft, step.from)) {
        draft[step.to] = draft[step.from];
        delete draft[step.from];
      }
    } else if (step.op === "set") {
      const evaluated = evalOrFail(step.expr, { ...root, input: draft });
      if (!evaluated.ok) return evaluated.result;
      draft[step.key] = evaluated.value;
    } else if (step.op === "coerce") {
      const value = draft[step.key];
      if (step.to === "string") draft[step.key] = value === undefined || value === null ? "" : String(value);
      else if (step.to === "number") {
        const number = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(number)) return failed("transform_coerce", `Field ${step.key} cannot be coerced to a number.`);
        draft[step.key] = number;
      } else if (value === true || value === "true") draft[step.key] = true;
      else if (value === false || value === "false") draft[step.key] = false;
      else return failed("transform_coerce", `Field ${step.key} cannot be coerced to a boolean.`);
    }
  }
  return { status: "succeeded", output: draft };
}

export function resolveIterationItems(node: Extract<WorkflowNode, { type: "iterate" }>, root: unknown): { items: unknown[] } | { error: { code: string; message: string } } {
  if (node.config.maxItems > LIMITS.maxIterationItems) {
    return { error: { code: "iterate_limit", message: "maxItems exceeds the hard cap." } };
  }
  const evaluated = evalOrFail(node.config.arrayExpr, root);
  if (!evaluated.ok) {
    return evaluated.result.status === "failed"
      ? { error: evaluated.result.error }
      : { error: { code: "expr_failed", message: "Expression failed." } };
  }
  if (!Array.isArray(evaluated.value)) return { error: { code: "iterate_not_array", message: "The iteration expression did not return an array." } };
  if (evaluated.value.length > node.config.maxItems) {
    return {
      error: {
        code: "iterate_limit",
        message: `The array has ${evaluated.value.length} items. This node allows ${node.config.maxItems}.`,
      },
    };
  }
  return { items: evaluated.value };
}

export async function executeNode(node: WorkflowNode, root: Record<string, unknown>, hooks: ExecuteHooks = {}): Promise<NodeResult> {
  try {
    switch (node.type) {
      case "manual_trigger":
      case "schedule_trigger":
      case "webhook_trigger":
        return { status: "succeeded", output: root.input ?? root.trigger ?? null };
      case "condition": {
        const evaluated = evalOrFail(node.config.expr, root);
        if (!evaluated.ok) return evaluated.result;
        if (typeof evaluated.value !== "boolean") {
          return failed("condition_not_boolean", "A condition expression must return a boolean. Exactly one branch runs.");
        }
        const selectedPort = evaluated.value ? "true" : "false";
        return { status: "succeeded", output: { result: evaluated.value, selectedPort }, selectedPort };
      }
      case "map_fields": {
        const value: Record<string, unknown> = {};
        for (const mapping of node.config.mappings) {
          const evaluated = evalOrFail(mapping.expr, root);
          if (!evaluated.ok) return evaluated.result;
          value[mapping.key] = evaluated.value;
        }
        const errors: string[] = [];
        for (const validation of node.config.validations ?? []) {
          const evaluated = evalOrFail(validation.expr, root);
          if (!evaluated.ok) return evaluated.result;
          if (evaluated.value !== true) errors.push(validation.message);
        }
        return { status: "succeeded", output: { valid: errors.length === 0, errors, value } };
      }
      case "transform":
        return applyTransform(root.input, node, root);
      case "merge": {
        const input = readObject(root.input);
        const branches = Array.isArray(input?.branches) ? input.branches : [];
        if (node.config.mode === "first_success") {
          const chosen = branches.find((entry) => readObject(entry)?.status === "succeeded");
          const record = readObject(chosen);
          if (!record) return failed("merge_none_succeeded", "Every incoming branch was skipped. first_success does not invent a value.");
          return { status: "succeeded", output: { chosenEdgeId: record.edgeId ?? null, nodeId: record.nodeId ?? null, value: record.value ?? null } };
        }
        return { status: "succeeded", output: { branches } };
      }
      case "output":
        return {
          status: "succeeded",
          output: {
            level: node.config.level,
            classification: node.config.classification ?? "log",
            message: node.config.message,
            data: root.input ?? null,
            item: root.item ?? null,
            index: root.index ?? null,
          },
        };
      case "delay": {
        const durationMs = node.config.durationMs;
        if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > LIMITS.maxDelayMs) {
          return failed("delay_invalid", "Delay duration is outside the allowed range.");
        }
        return { status: "waiting", waitMs: durationMs, passthrough: root.input ?? null };
      }
      case "iterate":
        return failed("iterate_internal", "Iteration is executed by the item runner, not as a single opaque step.");
      case "http_request":
        return executeHttp(node, root, hooks);
      default: {
        const neverNode: never = node;
        return failed("unsupported_node", `Unsupported node ${String(neverNode)}.`);
      }
    }
  } catch (error) {
    if (error instanceof ExprError) return failed(error.code, error.message);
    return failed("node_failed", error instanceof Error ? error.message : "Node failed.");
  }
}

async function executeHttp(node: Extract<WorkflowNode, { type: "http_request" }>, root: Record<string, unknown>, hooks: ExecuteHooks): Promise<NodeResult> {
  if (!hooks.http) return failed("http_unavailable", "No HTTP handler is configured.");
  let body: string | undefined;
  if (node.config.bodyExpr) {
    const evaluated = evalOrFail(node.config.bodyExpr, root);
    if (!evaluated.ok) return evaluated.result;
    body = typeof evaluated.value === "string" ? evaluated.value : JSON.stringify(evaluated.value);
    if (body && new TextEncoder().encode(body).length > LIMITS.maxPayloadBytes) {
      return failed("payload_limit", "HTTP request body exceeds the payload limit.");
    }
  }
  let idempotencyKey: string | null = null;
  if (node.config.idempotencyKeyExpr) {
    const evaluated = evalOrFail(node.config.idempotencyKeyExpr, root);
    if (!evaluated.ok) return evaluated.result;
    if (typeof evaluated.value !== "string" || evaluated.value.length === 0 || evaluated.value.length > 200) {
      return failed("idempotency_key", "Idempotency key expression must return a short string.");
    }
    idempotencyKey = evaluated.value;
  }
  const headers: Record<string, string> = {};
  for (const header of node.config.headers ?? []) headers[header.name] = header.value;
  if (body && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers[node.config.idempotencyHeader || "Idempotency-Key"] = idempotencyKey;
  for (const [name, value] of Object.entries(hooks.secrets?.headers ?? {})) headers[name] = value;
  const timeoutMs = node.timeoutMs ?? node.config.timeoutMs ?? LIMITS.defaultStepTimeoutMs;
  let response: HttpResult;
  try {
    response = await hooks.http({
      method: node.config.method,
      url: node.config.url,
      headers,
      ...(body !== undefined ? { body } : {}),
      timeoutMs,
      ...(hooks.signal ? { signal: hooks.signal } : {}),
    });
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "http_network";
    const retryable = node.config.retryable === true && code !== "ssrf_blocked";
    return failed(code, error instanceof Error ? error.message : "HTTP request failed.", retryable);
  }
  const output = redact({
    status: response.status,
    headers: response.headers,
    body: response.body,
    truncated: response.truncated === true,
    request: { method: node.config.method, url: node.config.url, idempotencyKey },
  });
  if (response.status >= 200 && response.status < 300) return { status: "succeeded", output };
  const retryable = node.config.retryable === true && (response.status === 408 || response.status === 429 || response.status >= 500);
  return failed("http_status", `HTTP ${response.status} from ${node.config.url}.`, retryable);
}

export type ItemResult = {
  index: number;
  item: unknown;
  status: "succeeded" | "failed";
  steps: StepSnapshot[];
  error?: { code: string; message: string };
};

export async function executeIterationItem(args: {
  doc: WorkflowDocument;
  iterateNodeId: string;
  item: unknown;
  index: number;
  trigger: unknown;
  priorNodes: Record<string, unknown>;
  hooks?: ExecuteHooks;
}): Promise<ItemResult> {
  const steps: StepSnapshot[] = [];
  let guard = 0;
  while (guard < 200) {
    guard += 1;
    const scope: PlanScope = { parentId: args.iterateNodeId, item: args.item, index: args.index };
    const plan = planGraph({ doc: args.doc, steps, scope });
    for (const created of plan.create.filter((entry) => entry.status === "skipped")) {
      steps.push({ nodeId: created.nodeId, nodeType: created.nodeType, status: "skipped", input: created.input ?? null, attempt: 0, selectedPort: null });
    }
    if (plan.finish?.status === "failed") {
      return { index: args.index, item: args.item, status: "failed", steps, error: { code: plan.finish.code ?? "body_failed", message: plan.finish.message ?? "Iteration body failed." } };
    }
    const next = plan.create.find((entry) => entry.status === "queued");
    if (!next) {
      return { index: args.index, item: args.item, status: "succeeded", steps };
    }
    const node = args.doc.nodes.find((entry) => entry.id === next.nodeId);
    if (!node) {
      return { index: args.index, item: args.item, status: "failed", steps, error: { code: "missing_node", message: `Missing body node ${next.nodeId}.` } };
    }
    const root = buildContext({
      doc: args.doc,
      steps,
      input: next.input,
      item: args.item,
      index: args.index,
      trigger: args.trigger,
      extraNodes: args.priorNodes,
    });
    const result = await executeNode(node, root, args.hooks ?? {});
    if (result.status === "waiting") {
      return { index: args.index, item: args.item, status: "failed", steps, error: { code: "delay_in_iteration", message: "Delay nodes cannot run inside an iteration." } };
    }
    if (result.status === "failed") {
      steps.push({ nodeId: node.id, nodeType: node.type, status: "failed", input: next.input ?? null, error: result.error, attempt: 1 });
      return { index: args.index, item: args.item, status: "failed", steps, error: result.error };
    }
    steps.push({
      nodeId: node.id,
      nodeType: node.type,
      status: "succeeded",
      input: next.input ?? null,
      output: result.output,
      selectedPort: result.selectedPort ?? null,
      attempt: 1,
    });
  }
  return { index: args.index, item: args.item, status: "failed", steps, error: { code: "iterate_guard", message: "Iteration body exceeded its guard." } };
}

export async function runInMemory(doc: WorkflowDocument, triggerOutput: unknown, hooks: ExecuteHooks = {}): Promise<{ status: RunStatus; steps: StepSnapshot[] }> {
  const trigger = doc.nodes.find((node) => isTrigger(node.type) && !node.iterationParent);
  if (!trigger) return { status: "failed", steps: [] };
  const steps: StepSnapshot[] = [
    { nodeId: trigger.id, nodeType: trigger.type, status: "succeeded", output: triggerOutput, input: null, attempt: 1, selectedPort: null },
  ];
  let guard = 0;
  while (guard < 500) {
    guard += 1;
    const plan = planGraph({ doc, steps });
    for (const created of plan.create) {
      if (steps.some((step) => step.nodeId === created.nodeId)) continue;
      steps.push({
        nodeId: created.nodeId,
        nodeType: created.nodeType,
        status: created.status,
        input: created.input ?? null,
        output: created.status === "skipped" ? { reason: created.reason ?? "skipped" } : undefined,
        attempt: 0,
      });
    }
    for (const nodeId of plan.cancel) {
      const step = steps.find((entry) => entry.nodeId === nodeId);
      if (step && (step.status === "queued" || step.status === "waiting")) step.status = "canceled";
    }
    if (plan.finish && !steps.some((step) => step.status === "queued" || step.status === "running")) {
      return { status: plan.finish.status, steps };
    }
    const ready = steps.filter((step) => step.status === "queued").sort((a, b) => a.nodeId.localeCompare(b.nodeId))[0];
    if (!ready) return { status: plan.runStatus, steps };
    const node = doc.nodes.find((entry) => entry.id === ready.nodeId);
    if (!node) return { status: "failed", steps };
    const policy = effectiveRetry(node);
    let attempt = ready.attempt ?? 0;
    let done = false;
    while (!done) {
      attempt += 1;
      ready.attempt = attempt;
      ready.status = "running";
      if (node.type === "iterate") {
        const root = buildContext({ doc, steps, input: ready.input, trigger: triggerOutput });
        const resolved = resolveIterationItems(node, root);
        if ("error" in resolved) {
          ready.status = "failed";
          ready.error = resolved.error;
          done = true;
          break;
        }
        const prior: Record<string, unknown> = {};
        for (const step of steps) if (step.status === "succeeded") prior[step.nodeId] = step.output;
        const results: ItemResult[] = [];
        let iterationFailed: { code: string; message: string } | null = null;
        for (let index = 0; index < resolved.items.length; index += 1) {
          const item = resolved.items[index];
          const itemResult = await executeIterationItem({
            doc,
            iterateNodeId: node.id,
            item,
            index,
            trigger: triggerOutput,
            priorNodes: prior,
            hooks,
          });
          results.push(itemResult);
          if (itemResult.status === "failed" && !node.config.continueOnError) {
            iterationFailed = itemResult.error ?? { code: "iterate_item_failed", message: "An iteration item failed." };
            break;
          }
        }
        ready.output = { count: results.length, results };
        if (iterationFailed) {
          ready.status = "failed";
          ready.error = iterationFailed;
        } else {
          ready.status = "succeeded";
        }
        done = true;
        break;
      }
      const root = buildContext({ doc, steps, input: ready.input, trigger: triggerOutput });
      const result = await executeNode(node, root, hooks);
      if (result.status === "waiting") {
        ready.status = "succeeded";
        ready.output = result.passthrough;
        done = true;
        break;
      }
      if (result.status === "failed") {
        ready.error = result.error;
        if (result.retryable && attempt < policy.maxAttempts) {
          ready.status = "queued";
          continue;
        }
        ready.status = "failed";
        done = true;
        break;
      }
      ready.status = "succeeded";
      ready.output = result.output;
      ready.selectedPort = result.selectedPort ?? null;
      done = true;
    }
    if (ready.status === "queued") {
      const delay = backoffDelayMs(policy, attempt);
      void delay;
    }
  }
  return { status: "failed", steps };
}
