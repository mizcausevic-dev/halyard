import { LIMITS } from "./limits.js";
import { findPort, PORTS } from "./ports.js";
import { containsPem, containsTokenMaterial, isSecretKey, jsonByteLength } from "./redact.js";
import { parseExpr } from "./expr.js";
import { assertCron } from "./schedule.js";
import { privateUrlWarning } from "./ssrf.js";
import {
  isTrigger,
  NODE_TYPES,
  type Expr,
  type NodeType,
  type TransformStep,
  type ValidationIssue,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode,
} from "./types.js";

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(code: string, message: string, extra?: Partial<ValidationIssue>): ValidationIssue {
  return { level: "error", code, message, ...extra };
}

function scanSecrets(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value === "string") {
    if (containsPem(value) || containsTokenMaterial(value)) {
      issues.push(issue("secret_material", `Imported value at ${path} contains secret material.`));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSecrets(entry, `${path}[${index}]`, issues));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      issues.push(issue("forbidden_key", `Field ${path}.${key} is not allowed.`));
      continue;
    }
    if (isSecretKey(key)) {
      issues.push(issue("secret_field", `Secret-shaped field "${key}" is not allowed at ${path}. Reference a credential instead.`));
      continue;
    }
    scanSecrets(entry, `${path}.${key}`, issues);
  }
}

function unknownKeys(record: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(record).filter((key) => !allowed.includes(key));
}

function readExpr(value: unknown, nodeId: string, label: string, issues: ValidationIssue[]): Expr | null {
  try {
    return parseExpr(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid expression.";
    issues.push(issue("expr_invalid", `${label}: ${message}`, { nodeId }));
    return null;
  }
}

function parseHeaders(value: unknown, nodeId: string, issues: ValidationIssue[]): { name: string; value: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(issue("config_invalid", "HTTP headers must be a list.", { nodeId }));
    return [];
  }
  if (value.length > 20) issues.push(issue("config_invalid", "HTTP nodes accept at most 20 headers.", { nodeId }));
  const headers: { name: string; value: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") {
      issues.push(issue("config_invalid", "Each header needs a name and value.", { nodeId }));
      continue;
    }
    if (!/^[A-Za-z0-9-]{1,64}$/.test(entry.name)) {
      issues.push(issue("config_invalid", `Header name ${entry.name} is not allowed.`, { nodeId }));
      continue;
    }
    if (/authorization|api-key|apikey|secret|token|cookie/i.test(entry.name)) {
      issues.push(issue("header_secret", `Header ${entry.name} must be supplied by a credential reference, not stored on the node.`, { nodeId }));
      continue;
    }
    if (entry.value.length > 512) {
      issues.push(issue("config_invalid", `Header ${entry.name} is too long.`, { nodeId }));
      continue;
    }
    headers.push({ name: entry.name, value: entry.value });
  }
  return headers;
}

function parseTransform(value: unknown, nodeId: string, issues: ValidationIssue[]): TransformStep[] {
  if (!Array.isArray(value)) {
    issues.push(issue("config_invalid", "Transform steps must be a list.", { nodeId }));
    return [];
  }
  if (value.length > 40) issues.push(issue("config_invalid", "Transform nodes accept at most 40 steps.", { nodeId }));
  const steps: TransformStep[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.op !== "string") {
      issues.push(issue("config_invalid", "A transform step needs an op.", { nodeId }));
      continue;
    }
    if (entry.op === "pick" || entry.op === "drop") {
      if (!Array.isArray(entry.keys) || entry.keys.some((key) => typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key))) {
        issues.push(issue("config_invalid", `${entry.op} needs a list of field names.`, { nodeId }));
        continue;
      }
      steps.push({ op: entry.op, keys: entry.keys });
      continue;
    }
    if (entry.op === "rename") {
      if (typeof entry.from !== "string" || typeof entry.to !== "string") {
        issues.push(issue("config_invalid", "rename needs from and to.", { nodeId }));
        continue;
      }
      steps.push({ op: "rename", from: entry.from, to: entry.to });
      continue;
    }
    if (entry.op === "set") {
      const expr = readExpr(entry.expr, nodeId, "set", issues);
      if (!expr || typeof entry.key !== "string") continue;
      steps.push({ op: "set", key: entry.key, expr });
      continue;
    }
    if (entry.op === "coerce") {
      if (typeof entry.key !== "string" || (entry.to !== "string" && entry.to !== "number" && entry.to !== "boolean")) {
        issues.push(issue("config_invalid", "coerce needs a key and a target type.", { nodeId }));
        continue;
      }
      steps.push({ op: "coerce", key: entry.key, to: entry.to });
      continue;
    }
    issues.push(issue("config_invalid", `Unsupported transform op ${entry.op}.`, { nodeId }));
  }
  return steps;
}

function parseNode(raw: unknown, issues: ValidationIssue[]): WorkflowNode | null {
  if (!isRecord(raw)) {
    issues.push(issue("node_shape", "Each node must be an object."));
    return null;
  }
  const bad = unknownKeys(raw, ["id", "type", "name", "position", "config", "iterationParent", "timeoutMs", "retry"]);
  if (bad.length > 0) issues.push(issue("unknown_field", `Unsupported node field: ${bad.join(", ")}.`));
  if (typeof raw.id !== "string" || !ID.test(raw.id)) {
    issues.push(issue("node_id", "Node ids must start with a letter and use letters, numbers, underscores, or hyphens."));
    return null;
  }
  const nodeId = raw.id;
  if (typeof raw.type !== "string" || !NODE_TYPES.includes(raw.type as NodeType)) {
    issues.push(issue("unsupported_node", `Unsupported node type${typeof raw.type === "string" ? `: ${raw.type}` : ""}.`, { nodeId }));
    return null;
  }
  const type = raw.type as NodeType;
  if (typeof raw.name !== "string" || raw.name.trim().length === 0 || raw.name.length > LIMITS.maxNameLength) {
    issues.push(issue("node_name", "Each node needs a name.", { nodeId }));
    return null;
  }
  let position = { x: 0, y: 0 };
  if (raw.position !== undefined) {
    if (!isRecord(raw.position) || typeof raw.position.x !== "number" || typeof raw.position.y !== "number" || !Number.isFinite(raw.position.x) || !Number.isFinite(raw.position.y)) {
      issues.push(issue("node_position", "Node position must be numeric.", { nodeId }));
      return null;
    }
    position = { x: raw.position.x, y: raw.position.y };
  }
  if (!isRecord(raw.config)) {
    issues.push(issue("config_invalid", "Node config must be an object.", { nodeId }));
    return null;
  }
  const config = parseConfig(type, raw.config, nodeId, issues);
  if (!config) return null;
  const node = {
    id: nodeId,
    type,
    name: raw.name.trim(),
    position,
    config,
  } as WorkflowNode;
  if (raw.iterationParent !== undefined) {
    if (typeof raw.iterationParent !== "string" || !ID.test(raw.iterationParent)) {
      issues.push(issue("iteration_parent", "iterationParent is not a node id.", { nodeId }));
      return null;
    }
    node.iterationParent = raw.iterationParent;
  }
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== "number" || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > LIMITS.maxStepTimeoutMs) {
      issues.push(issue("timeout_invalid", "timeoutMs is outside the allowed range.", { nodeId }));
      return null;
    }
    node.timeoutMs = raw.timeoutMs;
  }
  if (raw.retry !== undefined) {
    if (!isRecord(raw.retry)) {
      issues.push(issue("retry_invalid", "retry must be an object.", { nodeId }));
      return null;
    }
    const retryBad = unknownKeys(raw.retry, ["maxAttempts", "backoffMs", "multiplier"]);
    if (retryBad.length > 0) issues.push(issue("unknown_field", `Unsupported retry field: ${retryBad.join(", ")}.`, { nodeId }));
    const maxAttempts = raw.retry.maxAttempts;
    const backoffMs = raw.retry.backoffMs;
    const multiplier = raw.retry.multiplier;
    if (typeof maxAttempts !== "number" || typeof backoffMs !== "number" || typeof multiplier !== "number") {
      issues.push(issue("retry_invalid", "retry needs maxAttempts, backoffMs, and multiplier.", { nodeId }));
      return null;
    }
    node.retry = { maxAttempts, backoffMs, multiplier };
  }
  return node;
}

function parseConfig(type: NodeType, config: Record<string, unknown>, nodeId: string, issues: ValidationIssue[]): WorkflowNode["config"] | null {
  const allow = (keys: string[]) => {
    const bad = unknownKeys(config, keys);
    if (bad.length > 0) issues.push(issue("unknown_config", `Unsupported config field: ${bad.join(", ")}.`, { nodeId }));
  };
  switch (type) {
    case "manual_trigger": {
      allow(["samplePayload"]);
      return { samplePayload: config.samplePayload ?? null };
    }
    case "schedule_trigger": {
      allow(["cron", "timezone", "missedPolicy"]);
      const cron = typeof config.cron === "string" ? config.cron : "";
      const timezone = typeof config.timezone === "string" ? config.timezone : "";
      const missedPolicy = config.missedPolicy === "catch_up_once" ? "catch_up_once" : "skip";
      if (config.missedPolicy !== undefined && config.missedPolicy !== "skip" && config.missedPolicy !== "catch_up_once") {
        issues.push(issue("config_invalid", "missedPolicy must be skip or catch_up_once.", { nodeId }));
      }
      return { cron, timezone, missedPolicy };
    }
    case "webhook_trigger": {
      allow(["authMode", "credentialId", "secretHeader", "signatureHeader", "eventIdPath", "rateLimitPerMinute"]);
      const authMode = config.authMode === "none" || config.authMode === "hmac_sha256" ? config.authMode : "shared_secret";
      if (config.authMode !== undefined && config.authMode !== "none" && config.authMode !== "shared_secret" && config.authMode !== "hmac_sha256") {
        issues.push(issue("config_invalid", "Unsupported webhook auth mode.", { nodeId }));
      }
      const parsed: WorkflowNode & { type: "webhook_trigger" } = {
        id: nodeId,
        type,
        name: "",
        position: { x: 0, y: 0 },
        config: { authMode },
      };
      if (typeof config.credentialId === "string") {
        if (!UUID.test(config.credentialId)) issues.push(issue("credential_id", "credentialId must be a UUID.", { nodeId }));
        parsed.config.credentialId = config.credentialId;
      }
      if (typeof config.secretHeader === "string") parsed.config.secretHeader = config.secretHeader.slice(0, 64);
      if (typeof config.signatureHeader === "string") parsed.config.signatureHeader = config.signatureHeader.slice(0, 64);
      if (typeof config.eventIdPath === "string") {
        if (!/^[A-Za-z0-9_.-]{1,80}$/.test(config.eventIdPath)) {
          issues.push(issue("config_invalid", "eventIdPath contains unsupported characters.", { nodeId }));
        }
        parsed.config.eventIdPath = config.eventIdPath;
      }
      if (config.rateLimitPerMinute !== undefined) {
        if (typeof config.rateLimitPerMinute !== "number" || !Number.isInteger(config.rateLimitPerMinute) || config.rateLimitPerMinute < 1 || config.rateLimitPerMinute > LIMITS.maxWebhookRate) {
          issues.push(issue("config_invalid", "rateLimitPerMinute is outside the allowed range.", { nodeId }));
        } else {
          parsed.config.rateLimitPerMinute = config.rateLimitPerMinute;
        }
      }
      return parsed.config;
    }
    case "http_request": {
      allow(["method", "url", "headers", "bodyExpr", "credentialId", "timeoutMs", "retryable", "idempotencyKeyExpr", "idempotencyHeader"]);
      const method = typeof config.method === "string" ? config.method.toUpperCase() : "GET";
      if (!HTTP_METHODS.has(method)) issues.push(issue("config_invalid", "HTTP method is not allowed.", { nodeId }));
      const parsed: Extract<WorkflowNode, { type: "http_request" }>["config"] = {
        method: (HTTP_METHODS.has(method) ? method : "GET") as "GET",
        url: typeof config.url === "string" ? config.url : "",
        retryable: config.retryable === true,
      };
      const headers = parseHeaders(config.headers, nodeId, issues);
      if (headers.length > 0) parsed.headers = headers;
      if (config.bodyExpr !== undefined) {
        const expr = readExpr(config.bodyExpr, nodeId, "bodyExpr", issues);
        if (expr) parsed.bodyExpr = expr;
      }
      if (typeof config.credentialId === "string") {
        if (!UUID.test(config.credentialId)) issues.push(issue("credential_id", "credentialId must be a UUID.", { nodeId }));
        parsed.credentialId = config.credentialId;
      }
      if (config.timeoutMs !== undefined) {
        if (typeof config.timeoutMs !== "number" || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > LIMITS.maxStepTimeoutMs) {
          issues.push(issue("timeout_invalid", "HTTP timeout is outside the allowed range.", { nodeId }));
        } else parsed.timeoutMs = config.timeoutMs;
      }
      if (config.idempotencyKeyExpr !== undefined) {
        const expr = readExpr(config.idempotencyKeyExpr, nodeId, "idempotencyKeyExpr", issues);
        if (expr) parsed.idempotencyKeyExpr = expr;
      }
      if (typeof config.idempotencyHeader === "string" && /^[A-Za-z0-9-]{1,64}$/.test(config.idempotencyHeader)) {
        parsed.idempotencyHeader = config.idempotencyHeader;
      }
      return parsed;
    }
    case "condition": {
      allow(["expr"]);
      const expr = readExpr(config.expr, nodeId, "condition", issues);
      return expr ? { expr } : null;
    }
    case "map_fields": {
      allow(["mappings", "validations"]);
      if (!Array.isArray(config.mappings)) {
        issues.push(issue("config_invalid", "map_fields needs mappings.", { nodeId }));
        return null;
      }
      const mappings: { key: string; expr: Expr }[] = [];
      for (const entry of config.mappings) {
        if (!isRecord(entry) || typeof entry.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(entry.key)) {
          issues.push(issue("config_invalid", "Each mapping needs a field name.", { nodeId }));
          continue;
        }
        const expr = readExpr(entry.expr, nodeId, entry.key, issues);
        if (expr) mappings.push({ key: entry.key, expr });
      }
      const validations: { message: string; expr: Expr }[] = [];
      if (config.validations !== undefined) {
        if (!Array.isArray(config.validations)) {
          issues.push(issue("config_invalid", "validations must be a list.", { nodeId }));
        } else {
          for (const entry of config.validations) {
            if (!isRecord(entry) || typeof entry.message !== "string" || entry.message.length > 200) {
              issues.push(issue("config_invalid", "Each validation needs a message.", { nodeId }));
              continue;
            }
            const expr = readExpr(entry.expr, nodeId, "validation", issues);
            if (expr) validations.push({ message: entry.message, expr });
          }
        }
      }
      return validations.length > 0 ? { mappings, validations } : { mappings };
    }
    case "iterate": {
      allow(["arrayExpr", "maxItems", "continueOnError"]);
      const arrayExpr = readExpr(config.arrayExpr, nodeId, "arrayExpr", issues);
      const maxItems = typeof config.maxItems === "number" ? config.maxItems : LIMITS.defaultIterationItems;
      if (!Number.isInteger(maxItems) || maxItems < 0 || maxItems > LIMITS.maxIterationItems) {
        issues.push(issue("iterate_limit", `maxItems must be an integer from 0 to ${LIMITS.maxIterationItems}.`, { nodeId }));
      }
      if (!arrayExpr) return null;
      return { arrayExpr, maxItems, continueOnError: config.continueOnError === true };
    }
    case "delay": {
      allow(["durationMs"]);
      const durationMs = config.durationMs;
      if (typeof durationMs !== "number" || !Number.isInteger(durationMs) || durationMs < 0 || durationMs > LIMITS.maxDelayMs) {
        issues.push(issue("delay_invalid", "durationMs is outside the allowed range.", { nodeId }));
        return { durationMs: 0 };
      }
      return { durationMs };
    }
    case "transform": {
      allow(["steps"]);
      return { steps: parseTransform(config.steps, nodeId, issues) };
    }
    case "merge": {
      allow(["mode"]);
      if (config.mode !== undefined && config.mode !== "all" && config.mode !== "first_success") {
        issues.push(issue("config_invalid", "merge mode must be all or first_success.", { nodeId }));
      }
      return { mode: config.mode === "first_success" ? "first_success" : "all" };
    }
    case "output": {
      allow(["level", "message", "classification"]);
      const level = config.level === "warning" || config.level === "error" ? config.level : "info";
      const classification = config.classification === "accepted" || config.classification === "rejected" || config.classification === "log" ? config.classification : "log";
      const message = typeof config.message === "string" ? config.message.slice(0, 500) : "";
      return { level, message, classification };
    }
    default:
      return null;
  }
}

function parseEdge(raw: unknown, issues: ValidationIssue[]): WorkflowEdge | null {
  if (!isRecord(raw)) {
    issues.push(issue("edge_shape", "Each edge must be an object."));
    return null;
  }
  const bad = unknownKeys(raw, ["id", "source", "sourcePort", "target", "targetPort"]);
  if (bad.length > 0) issues.push(issue("unknown_field", `Unsupported edge field: ${bad.join(", ")}.`));
  if (typeof raw.id !== "string" || !ID.test(raw.id)) {
    issues.push(issue("edge_id", "Edge ids use the same rules as node ids."));
    return null;
  }
  if (typeof raw.source !== "string" || typeof raw.target !== "string" || typeof raw.sourcePort !== "string" || typeof raw.targetPort !== "string") {
    issues.push(issue("edge_shape", "An edge needs source, sourcePort, target, and targetPort.", { edgeId: raw.id }));
    return null;
  }
  return { id: raw.id, source: raw.source, sourcePort: raw.sourcePort, target: raw.target, targetPort: raw.targetPort };
}

export function validateDocument(input: unknown, mode: "draft" | "publish"): { document: WorkflowDocument | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { document: null, issues: [issue("document_shape", "A workflow document must be a JSON object.")] };
  try {
    if (jsonByteLength(input) > LIMITS.maxDocumentBytes) {
      return { document: null, issues: [issue("document_size", "Workflow document exceeds the size limit.")] };
    }
  } catch {
    return { document: null, issues: [issue("document_shape", "Workflow document is not serializable JSON.")] };
  }
  scanSecrets(input, "$", issues);
  if (issues.some((entry) => entry.code === "secret_field" || entry.code === "secret_material" || entry.code === "forbidden_key")) {
    return { document: null, issues };
  }
  const bad = unknownKeys(input, ["schemaVersion", "name", "description", "settings", "nodes", "edges"]);
  if (bad.length > 0) issues.push(issue("unknown_field", `Unsupported document field: ${bad.join(", ")}.`));
  if (input.schemaVersion !== 1) {
    issues.push(issue("unsupported_schema", "Only schemaVersion 1 is accepted."));
    return { document: null, issues };
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > LIMITS.maxNameLength) {
    issues.push(issue("name_invalid", "Workflow name is required."));
  }
  const description = typeof input.description === "string" ? input.description.slice(0, 2_000) : "";
  let parallelism: number = LIMITS.defaultParallelism;
  let runTimeoutMs: number = LIMITS.defaultRunTimeoutMs;
  if (input.settings !== undefined) {
    if (!isRecord(input.settings)) {
      issues.push(issue("settings_invalid", "Settings must be an object."));
    } else {
      const settingsBad = unknownKeys(input.settings, ["parallelism", "runTimeoutMs"]);
      if (settingsBad.length > 0) issues.push(issue("unknown_field", `Unsupported settings field: ${settingsBad.join(", ")}.`));
      if (typeof input.settings.parallelism === "number") parallelism = input.settings.parallelism;
      if (typeof input.settings.runTimeoutMs === "number") runTimeoutMs = input.settings.runTimeoutMs;
    }
  }
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > LIMITS.maxParallelism) {
    issues.push(issue("settings_invalid", `parallelism must be an integer from 1 to ${LIMITS.maxParallelism}.`));
  }
  if (!Number.isInteger(runTimeoutMs) || runTimeoutMs < 1_000 || runTimeoutMs > LIMITS.maxRunTimeoutMs) {
    issues.push(issue("settings_invalid", "runTimeoutMs is outside the allowed range."));
  }
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    issues.push(issue("document_shape", "nodes and edges must be arrays."));
    return { document: null, issues };
  }
  if (input.nodes.length > LIMITS.maxNodes) issues.push(issue("limit", `A workflow can contain at most ${LIMITS.maxNodes} nodes.`));
  if (input.edges.length > LIMITS.maxEdges) issues.push(issue("limit", `A workflow can contain at most ${LIMITS.maxEdges} edges.`));
  const nodes = input.nodes.map((node) => parseNode(node, issues)).filter((node): node is WorkflowNode => node !== null);
  const edges = input.edges.map((edge) => parseEdge(edge, issues)).filter((edge): edge is WorkflowEdge => edge !== null);
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) issues.push(issue("duplicate_id", "Node ids must be unique."));
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) issues.push(issue("duplicate_id", "Edge ids must be unique."));
  if (issues.some((entry) => entry.level === "error")) return { document: null, issues };
  const document: WorkflowDocument = {
    schemaVersion: 1,
    name: String(input.name).trim(),
    description,
    settings: { parallelism, runTimeoutMs },
    nodes,
    edges,
  };
  if (mode === "publish") issues.push(...publishIssues(document));
  return { document, issues };
}

function scopeId(node: WorkflowNode): string | null {
  return node.iterationParent ?? null;
}

function cycleIn(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] | null {
  const ids = new Set(nodes.map((node) => node.id));
  const adjacent = new Map<string, string[]>();
  for (const id of ids) adjacent.set(id, []);
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    adjacent.get(edge.source)?.push(edge.target);
  }
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, 1);
    stack.push(id);
    for (const next of adjacent.get(id) ?? []) {
      const state = color.get(next) ?? 0;
      if (state === 1) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (state === 0) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const id of ids) {
    if ((color.get(id) ?? 0) === 0) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

function reachable(start: string[], nodes: WorkflowNode[], edges: WorkflowEdge[]): Set<string> {
  const allowed = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id) || !allowed.has(id)) continue;
    seen.add(id);
    for (const edge of edges) if (edge.source === id) stack.push(edge.target);
  }
  return seen;
}

export function publishIssues(doc: WorkflowDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const triggers = doc.nodes.filter((node) => isTrigger(node.type) && !node.iterationParent);
  if (triggers.length !== 1) {
    issues.push(issue("trigger_count", "A published workflow needs exactly one top-level trigger."));
  }
  if (doc.nodes.filter((node) => !node.iterationParent).length < 2) {
    issues.push(issue("no_work", "Publish at least one node downstream of the trigger."));
  }
  for (const node of doc.nodes) {
    if (!node.iterationParent) continue;
    const parent = byId.get(node.iterationParent);
    if (!parent || parent.type !== "iterate") {
      issues.push(issue("iteration_parent", "iterationParent must reference an iterate node.", { nodeId: node.id }));
    } else if (parent.iterationParent) {
      issues.push(issue("nested_iteration", "Iteration is only one level deep.", { nodeId: node.id }));
    }
    if (node.type === "iterate") issues.push(issue("nested_iteration", "An iterate node cannot live inside another iteration.", { nodeId: node.id }));
    if (node.type === "delay") issues.push(issue("delay_in_iteration", "Delay nodes are top-level only. A body runs to completion inside one item job.", { nodeId: node.id }));
    if (isTrigger(node.type)) issues.push(issue("trigger_nested", "Triggers cannot live inside an iteration.", { nodeId: node.id }));
  }
  for (const edge of doc.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      issues.push(issue("edge_endpoint", "Edge endpoints must be nodes in the document.", { edgeId: edge.id }));
      continue;
    }
    if (edge.source === edge.target) issues.push(issue("cycle", "An edge cannot connect a node to itself.", { edgeId: edge.id }));
    if (scopeId(source) !== scopeId(target)) {
      issues.push(issue("edge_scope", "Edges cannot cross into or out of an iteration body.", { edgeId: edge.id }));
    }
    if (!findPort(source.type, edge.sourcePort, "out")) {
      issues.push(issue("port", `${source.name} has no output port ${edge.sourcePort}.`, { edgeId: edge.id, nodeId: source.id }));
    }
    if (!findPort(target.type, edge.targetPort, "in")) {
      issues.push(issue("port", `${target.name} has no input port ${edge.targetPort}.`, { edgeId: edge.id, nodeId: target.id }));
    }
  }
  const scopes = new Set<string | null>(doc.nodes.map((node) => scopeId(node)));
  for (const scope of scopes) {
    const nodes = doc.nodes.filter((node) => scopeId(node) === scope);
    const edges = doc.edges.filter((edge) => {
      const source = byId.get(edge.source);
      return source ? scopeId(source) === scope : false;
    });
    const cycle = cycleIn(nodes, edges);
    if (cycle) issues.push(issue("cycle", `Published workflows are acyclic. Cycle: ${cycle.join(" -> ")}.`));
  }
  for (const node of doc.nodes) {
    if (isTrigger(node.type)) continue;
    const incoming = doc.edges.filter((edge) => edge.target === node.id);
    const isBodyEntry = Boolean(node.iterationParent) && incoming.length === 0;
    for (const port of PORTS[node.type].filter((entry) => entry.direction === "in")) {
      const count = incoming.filter((edge) => edge.targetPort === port.id).length;
      if (port.required && count === 0 && !isBodyEntry) {
        issues.push(issue("port_required", `${node.name} is missing a connection to ${port.id}.`, { nodeId: node.id }));
      }
      if (!port.multiple && count > 1) {
        issues.push(issue("port_cardinality", `${node.name} accepts one connection on ${port.id}.`, { nodeId: node.id }));
      }
    }
  }
  const trigger = triggers[0];
  if (trigger) {
    const top = doc.nodes.filter((node) => !node.iterationParent);
    const topEdges = doc.edges.filter((edge) => byId.get(edge.source)?.iterationParent === undefined);
    const seen = reachable([trigger.id], top, topEdges);
    for (const node of top) {
      if (!seen.has(node.id)) issues.push(issue("unreachable", `${node.name} is not reachable from the trigger.`, { nodeId: node.id }));
    }
  }
  for (const parent of doc.nodes.filter((node) => node.type === "iterate")) {
    const body = doc.nodes.filter((node) => node.iterationParent === parent.id);
    const bodyEdges = doc.edges.filter((edge) => byId.get(edge.source)?.iterationParent === parent.id);
    const entries = body.filter((node) => !bodyEdges.some((edge) => edge.target === node.id)).map((node) => node.id);
    const seen = reachable(entries, body, bodyEdges);
    for (const node of body) {
      if (!seen.has(node.id)) issues.push(issue("unreachable", `${node.name} is not reachable inside its iteration.`, { nodeId: node.id }));
    }
  }
  for (const node of doc.nodes) {
    if (node.type === "schedule_trigger") {
      if (!node.config.cron || !node.config.timezone) {
        issues.push(issue("schedule_invalid", "A schedule needs a cron expression and an IANA timezone.", { nodeId: node.id }));
      } else {
        try {
          assertCron(node.config.cron, node.config.timezone);
        } catch (error) {
          issues.push(issue("schedule_invalid", error instanceof Error ? error.message : "Invalid schedule.", { nodeId: node.id }));
        }
      }
    }
    if (node.type === "webhook_trigger") {
      if (node.config.authMode === "none") {
        issues.push({ level: "warning", code: "webhook_unauthenticated", message: "This webhook accepts unauthenticated JSON.", nodeId: node.id });
      } else if (!node.config.credentialId) {
        issues.push(issue("credential_required", "This webhook authentication mode needs a credential.", { nodeId: node.id }));
      }
    }
    if (node.type === "http_request") {
      if (!node.config.url) {
        issues.push(issue("url_required", `${node.name} needs an absolute http or https URL.`, { nodeId: node.id }));
      } else {
        const warning = privateUrlWarning(node.config.url);
        if (warning) issues.push({ level: "warning", code: "private_url", message: warning, nodeId: node.id });
        try {
          const url = new URL(node.config.url);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            issues.push(issue("url_protocol", "Only http and https URLs are allowed.", { nodeId: node.id }));
          }
        } catch {
          issues.push(issue("url_invalid", "The HTTP node URL could not be parsed.", { nodeId: node.id }));
        }
      }
      if (node.config.retryable && !node.config.idempotencyKeyExpr) {
        issues.push({
          level: "warning",
          code: "retry_without_idempotency",
          message: "Retryable HTTP can repeat a side effect. Set an idempotency key only if the destination stores it.",
          nodeId: node.id,
        });
      }
    }
    if (node.type === "merge" && doc.edges.filter((edge) => edge.target === node.id).length < 2) {
      issues.push({ level: "warning", code: "merge_single", message: "This merge has fewer than two incoming branches.", nodeId: node.id });
    }
  }
  return issues;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((entry) => entry.level === "error");
}
