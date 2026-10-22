import type { WorkflowDocument } from "./types.js";

export const EXAMPLE_CREDENTIAL_ID = "00000000-0000-4000-8000-0000000000c1";
export const FIXTURE_HOST = "127.0.0.1:4099";

export function fixtureUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

export function exampleDocuments(fixtureBase = `http://${FIXTURE_HOST}`): {
  intake: WorkflowDocument;
  digest: WorkflowDocument;
  batch: WorkflowDocument;
} {
  const intake: WorkflowDocument = {
    schemaVersion: 1,
    name: "Order intake",
    description: "Webhook, field checks, one condition branch, then an HTTP accept or a rejection log.",
    settings: { parallelism: 1, runTimeoutMs: 60_000 },
    nodes: [
      {
        id: "hook",
        type: "webhook_trigger",
        name: "Order webhook",
        position: { x: 48, y: 120 },
        config: {
          authMode: "shared_secret",
          credentialId: EXAMPLE_CREDENTIAL_ID,
          secretHeader: "X-Halyard-Secret",
          eventIdPath: "eventId",
          rateLimitPerMinute: 30,
        },
      },
      {
        id: "map",
        type: "map_fields",
        name: "Validate order",
        position: { x: 328, y: 120 },
        config: {
          mappings: [
            { key: "email", expr: { op: "get", path: "input.body.email" } },
            { key: "amount", expr: { op: "get", path: "input.body.amount" } },
          ],
          validations: [
            {
              message: "Email must contain @",
              expr: { op: "contains", value: { op: "get", path: "input.body.email" }, search: { op: "lit", value: "@" } },
            },
            {
              message: "Amount must be greater than 0",
              expr: { op: "gt", left: { op: "get", path: "input.body.amount" }, right: { op: "lit", value: 0 } },
            },
          ],
        },
      },
      {
        id: "gate",
        type: "condition",
        name: "Is valid",
        position: { x: 608, y: 120 },
        config: { expr: { op: "eq", left: { op: "get", path: "input.valid" }, right: { op: "lit", value: true } } },
      },
      {
        id: "accept",
        type: "http_request",
        name: "Accept order",
        position: { x: 888, y: 40 },
        config: {
          method: "POST",
          url: fixtureUrl(fixtureBase, "/orders/accept"),
          retryable: false,
          timeoutMs: 5000,
          idempotencyKeyExpr: { op: "get", path: "trigger.body.eventId" },
          bodyExpr: {
            op: "object",
            entries: [
              { key: "email", value: { op: "get", path: "nodes.map.value.email" } },
              { key: "amount", value: { op: "get", path: "nodes.map.value.amount" } },
            ],
          },
        },
      },
      {
        id: "reject",
        type: "output",
        name: "Reject order",
        position: { x: 888, y: 230 },
        config: { level: "warning", message: "Order failed validation", classification: "rejected" },
      },
    ],
    edges: [
      { id: "e1", source: "hook", sourcePort: "out", target: "map", targetPort: "in" },
      { id: "e2", source: "map", sourcePort: "out", target: "gate", targetPort: "in" },
      { id: "e3", source: "gate", sourcePort: "true", target: "accept", targetPort: "in" },
      { id: "e4", source: "gate", sourcePort: "false", target: "reject", targetPort: "in" },
    ],
  };

  const digest: WorkflowDocument = {
    schemaVersion: 1,
    name: "Morning digest",
    description: "Scheduled fetch, field mapping, and a log of the mapped report.",
    settings: { parallelism: 1, runTimeoutMs: 60_000 },
    nodes: [
      {
        id: "clock",
        type: "schedule_trigger",
        name: "06:00 America/New_York",
        position: { x: 48, y: 80 },
        config: { cron: "0 6 * * *", timezone: "America/New_York", missedPolicy: "skip" },
      },
      {
        id: "fetch",
        type: "http_request",
        name: "Fetch daily report",
        position: { x: 328, y: 80 },
        config: { method: "GET", url: fixtureUrl(fixtureBase, "/reports/daily"), retryable: false, timeoutMs: 5000 },
      },
      {
        id: "shape",
        type: "map_fields",
        name: "Map report rows",
        position: { x: 608, y: 80 },
        config: {
          mappings: [
            { key: "count", expr: { op: "length", arg: { op: "get", path: "input.body.rows" } } },
            { key: "firstSku", expr: { op: "get", path: "input.body.rows.0.sku" } },
          ],
        },
      },
      {
        id: "report",
        type: "output",
        name: "Digest log",
        position: { x: 888, y: 80 },
        config: { level: "info", message: "Daily report mapped", classification: "log" },
      },
    ],
    edges: [
      { id: "d1", source: "clock", sourcePort: "out", target: "fetch", targetPort: "in" },
      { id: "d2", source: "fetch", sourcePort: "out", target: "shape", targetPort: "in" },
      { id: "d3", source: "shape", sourcePort: "out", target: "report", targetPort: "in" },
    ],
  };

  const batch: WorkflowDocument = {
    schemaVersion: 1,
    name: "Amount split",
    description: "Manual run, bounded iteration, one condition per item, and a branch log.",
    settings: { parallelism: 1, runTimeoutMs: 60_000 },
    nodes: [
      {
        id: "start",
        type: "manual_trigger",
        name: "Manual trigger",
        position: { x: 48, y: 80 },
        config: {
          samplePayload: {
            items: [
              { sku: "INK-4", amount: 140 },
              { sku: "PAPER", amount: 40 },
              { sku: "PRESS", amount: 220 },
            ],
          },
        },
      },
      {
        id: "batch",
        type: "iterate",
        name: "Each item",
        position: { x: 328, y: 80 },
        config: { arrayExpr: { op: "get", path: "trigger.body.items" }, maxItems: 10, continueOnError: false },
      },
      {
        id: "check",
        type: "condition",
        name: "Amount over 100",
        iterationParent: "batch",
        position: { x: 628, y: 250 },
        config: { expr: { op: "gt", left: { op: "get", path: "item.amount" }, right: { op: "lit", value: 100 } } },
      },
      {
        id: "approved",
        type: "output",
        name: "Approved",
        iterationParent: "batch",
        position: { x: 908, y: 180 },
        config: { level: "info", message: "Approved", classification: "accepted" },
      },
      {
        id: "held",
        type: "output",
        name: "Held",
        iterationParent: "batch",
        position: { x: 908, y: 340 },
        config: { level: "warning", message: "Held", classification: "rejected" },
      },
      {
        id: "summary",
        type: "output",
        name: "Batch summary",
        position: { x: 628, y: 80 },
        config: { level: "info", message: "Iteration finished", classification: "log" },
      },
    ],
    edges: [
      { id: "b1", source: "start", sourcePort: "out", target: "batch", targetPort: "in" },
      { id: "b2", source: "batch", sourcePort: "out", target: "summary", targetPort: "in" },
      { id: "b3", source: "check", sourcePort: "true", target: "approved", targetPort: "in" },
      { id: "b4", source: "check", sourcePort: "false", target: "held", targetPort: "in" },
    ],
  };

  return { intake, digest, batch };
}

export const ORDER_SAMPLE = { eventId: "evt_1001", email: "ada@example.com", amount: 42 };
export const ORDER_INVALID = { eventId: "evt_1002", email: "not-an-email", amount: 0 };
