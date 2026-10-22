import { clamp, LIMITS } from "./limits.js";
import type { RetryPolicy, StepSnapshot, WorkflowNode } from "./types.js";

export function effectiveRetry(node: WorkflowNode): RetryPolicy {
  if (node.type === "http_request" && node.config.retryable !== true) {
    return { maxAttempts: 1, backoffMs: 0, multiplier: 1 };
  }
  return {
    maxAttempts: clamp(node.retry?.maxAttempts ?? 3, 1, LIMITS.maxAttemptsCap),
    backoffMs: clamp(node.retry?.backoffMs ?? LIMITS.defaultBackoffMs, 0, LIMITS.maxBackoffMs),
    multiplier: clamp(node.retry?.multiplier ?? 2, 1, 5),
  };
}

export function backoffDelayMs(policy: RetryPolicy, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.backoffMs * policy.multiplier ** exponent, LIMITS.maxBackoffMs);
}

export function crashRecovery(node: WorkflowNode, step: StepSnapshot): "execute" | "complete" | "uncertain" {
  if (step.status === "succeeded" || step.status === "skipped" || step.status === "canceled" || step.status === "failed" || step.status === "waiting") {
    return "complete";
  }
  if (step.status === "running" && (step.attempt ?? 0) >= effectiveRetry(node).maxAttempts) return "uncertain";
  return "execute";
}
