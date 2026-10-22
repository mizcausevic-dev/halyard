import type { NodeType, WorkflowNode } from "./types.js";

export function defaultNode(type: NodeType, id: string, position: { x: number; y: number }): WorkflowNode {
  const base = { id, name: labelFor(type), position };
  switch (type) {
    case "manual_trigger":
      return { ...base, type, config: { samplePayload: {} } };
    case "schedule_trigger":
      return { ...base, type, config: { cron: "0 6 * * *", timezone: "UTC", missedPolicy: "skip" } };
    case "webhook_trigger":
      return {
        ...base,
        type,
        config: { authMode: "shared_secret", secretHeader: "X-Halyard-Secret", rateLimitPerMinute: 60 },
      };
    case "http_request":
      return { ...base, type, config: { method: "GET", url: "", retryable: false, timeoutMs: 10000 } };
    case "condition":
      return {
        ...base,
        type,
        config: {
          expr: { op: "eq", left: { op: "get", path: "input.valid" }, right: { op: "lit", value: true } },
        },
      };
    case "map_fields":
      return { ...base, type, config: { mappings: [{ key: "value", expr: { op: "get", path: "input.body" } }] } };
    case "iterate":
      return {
        ...base,
        type,
        config: { arrayExpr: { op: "get", path: "trigger.body.items" }, maxItems: 25, continueOnError: false },
      };
    case "delay":
      return { ...base, type, config: { durationMs: 60_000 } };
    case "transform":
      return { ...base, type, config: { steps: [{ op: "pick", keys: [] }] } };
    case "merge":
      return { ...base, type, config: { mode: "all" } };
    case "output":
      return { ...base, type, config: { level: "info", message: "", classification: "log" } };
    default: {
      const neverType: never = type;
      throw new Error(`Unsupported node ${String(neverType)}`);
    }
  }
}

export function labelFor(type: NodeType): string {
  switch (type) {
    case "manual_trigger":
      return "Manual trigger";
    case "schedule_trigger":
      return "Schedule";
    case "webhook_trigger":
      return "Webhook";
    case "http_request":
      return "HTTP request";
    case "condition":
      return "Condition";
    case "map_fields":
      return "Map fields";
    case "iterate":
      return "Iterate";
    case "delay":
      return "Delay";
    case "transform":
      return "Transform";
    case "merge":
      return "Merge";
    case "output":
      return "Output";
    default: {
      const neverType: never = type;
      return String(neverType);
    }
  }
}

export const NODE_HELP: Record<NodeType, string> = {
  manual_trigger: "Starts a run when someone clicks Run now. The JSON body becomes trigger.body.",
  schedule_trigger: "Fires on a cron expression in an IANA timezone. Missed ticks follow the selected policy.",
  webhook_trigger: "Accepts a JSON POST. The secret stays in a credential, not in this node.",
  http_request: "Calls an http or https URL. Retries are off unless you opt in. An idempotency key is only as good as the destination.",
  condition: "Runs exactly one branch. The expression must return a boolean.",
  map_fields: "Builds an object and records validation messages. An invalid payload does not throw. The condition decides the branch.",
  iterate: "Walks an array up to maxItems, one item at a time. Child nodes belong to this node. This is not a graph cycle.",
  delay: "Writes a resume job and stops. The worker does not sleep inside the request. The wait survives a restart.",
  transform: "Applies a fixed list of pick, drop, rename, set, and coerce steps. No JavaScript.",
  merge: "Waits until every incoming branch has succeeded or been skipped. all keeps each branch. first_success takes the first success in edge order.",
  output: "Records a log on the step. A rejection classification does not undo earlier side effects, and it does not by itself fail the run.",
};
