export const NODE_TYPES = [
  "manual_trigger",
  "schedule_trigger",
  "webhook_trigger",
  "http_request",
  "condition",
  "map_fields",
  "iterate",
  "delay",
  "transform",
  "merge",
  "output",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export const TRIGGER_TYPES = ["manual_trigger", "schedule_trigger", "webhook_trigger"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export type StepStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "canceled"
  | "skipped";

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "canceled";

export type Expr =
  | { op: "lit"; value: string | number | boolean | null }
  | { op: "get"; path: string }
  | { op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; left: Expr; right: Expr }
  | { op: "and" | "or"; args: Expr[] }
  | { op: "not"; arg: Expr }
  | { op: "add" | "sub" | "mul" | "div"; left: Expr; right: Expr }
  | { op: "concat"; args: Expr[] }
  | { op: "lower" | "upper" | "trim"; arg: Expr }
  | { op: "contains"; value: Expr; search: Expr }
  | { op: "coalesce"; args: Expr[] }
  | { op: "length"; arg: Expr }
  | { op: "if"; cond: Expr; then: Expr; else: Expr }
  | { op: "object"; entries: { key: string; value: Expr }[] };

export type RetryPolicy = {
  maxAttempts: number;
  backoffMs: number;
  multiplier: number;
};

export type TransformStep =
  | { op: "pick"; keys: string[] }
  | { op: "drop"; keys: string[] }
  | { op: "rename"; from: string; to: string }
  | { op: "set"; key: string; expr: Expr }
  | { op: "coerce"; key: string; to: "string" | "number" | "boolean" };

type NodeBase = {
  id: string;
  name: string;
  position: { x: number; y: number };
  iterationParent?: string;
  timeoutMs?: number;
  retry?: RetryPolicy;
};

export type WorkflowNode = NodeBase &
  (
    | { type: "manual_trigger"; config: { samplePayload?: unknown } }
    | {
        type: "schedule_trigger";
        config: { cron: string; timezone: string; missedPolicy: "skip" | "catch_up_once" };
      }
    | {
        type: "webhook_trigger";
        config: {
          authMode: "none" | "shared_secret" | "hmac_sha256";
          credentialId?: string;
          secretHeader?: string;
          signatureHeader?: string;
          eventIdPath?: string;
          rateLimitPerMinute?: number;
        };
      }
    | {
        type: "http_request";
        config: {
          method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
          url: string;
          headers?: { name: string; value: string }[];
          bodyExpr?: Expr;
          credentialId?: string;
          timeoutMs?: number;
          retryable?: boolean;
          idempotencyKeyExpr?: Expr;
          idempotencyHeader?: string;
        };
      }
    | { type: "condition"; config: { expr: Expr } }
    | {
        type: "map_fields";
        config: {
          mappings: { key: string; expr: Expr }[];
          validations?: { message: string; expr: Expr }[];
        };
      }
    | {
        type: "iterate";
        config: { arrayExpr: Expr; maxItems: number; continueOnError?: boolean };
      }
    | { type: "delay"; config: { durationMs: number } }
    | { type: "transform"; config: { steps: TransformStep[] } }
    | { type: "merge"; config: { mode: "all" | "first_success" } }
    | {
        type: "output";
        config: {
          level: "info" | "warning" | "error";
          message: string;
          classification?: "accepted" | "rejected" | "log";
        };
      }
  );

export type WorkflowEdge = {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
};

export type WorkflowDocument = {
  schemaVersion: 1;
  name: string;
  description: string;
  settings: {
    parallelism: number;
    runTimeoutMs: number;
  };
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export type ValidationIssue = {
  level: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
};

export type StepSnapshot = {
  nodeId: string;
  nodeType: NodeType;
  status: StepStatus;
  input?: unknown;
  output?: unknown;
  selectedPort?: string | null;
  attempt?: number;
  error?: { code: string; message: string } | null;
};

export function isTrigger(type: NodeType): type is TriggerType {
  return type === "manual_trigger" || type === "schedule_trigger" || type === "webhook_trigger";
}
