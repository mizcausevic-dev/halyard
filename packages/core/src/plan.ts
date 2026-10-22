import { isTrigger, type StepSnapshot, type WorkflowDocument, type WorkflowEdge, type WorkflowNode } from "./types.js";

export type PlanScope = {
  parentId: string;
  item: unknown;
  index: number;
};

export type PlannedStep = {
  nodeId: string;
  nodeType: WorkflowNode["type"];
  status: "queued" | "skipped";
  input: unknown;
  reason?: string;
};

export type PlanResult = {
  create: PlannedStep[];
  cancel: string[];
  finish?: { status: "succeeded" | "failed" | "canceled"; code?: string; message?: string };
  runStatus: "running" | "waiting" | "succeeded" | "failed" | "canceled";
};

type EdgeClass = "pending" | "active" | "inactive" | "blocked";

function inScope(node: WorkflowNode, scope: PlanScope | undefined): boolean {
  if (scope) return node.iterationParent === scope.parentId;
  return !node.iterationParent;
}

function classify(doc: WorkflowDocument, edge: WorkflowEdge, steps: Map<string, StepSnapshot>): EdgeClass {
  const step = steps.get(edge.source);
  if (!step || step.status === "queued" || step.status === "running" || step.status === "waiting") return "pending";
  if (step.status === "failed" || step.status === "canceled") return "blocked";
  if (step.status === "skipped") return "inactive";
  const source = doc.nodes.find((node) => node.id === edge.source);
  if (!source) return "blocked";
  if (source.type === "condition") {
    if (!step.selectedPort) return "blocked";
    return step.selectedPort === edge.sourcePort ? "active" : "inactive";
  }
  return edge.sourcePort === "out" ? "active" : "inactive";
}

export function buildNodeInput(doc: WorkflowDocument, node: WorkflowNode, steps: Map<string, StepSnapshot>, scope?: PlanScope): unknown {
  const incoming = doc.edges.filter((edge) => edge.target === node.id);
  if (node.type === "merge") {
    return {
      mode: node.config.mode,
      branches: incoming.map((edge) => {
        const source = doc.nodes.find((entry) => entry.id === edge.source);
        const step = steps.get(edge.source);
        const active = classify(doc, edge, steps) === "active";
        return {
          edgeId: edge.id,
          nodeId: edge.source,
          nodeName: source?.name ?? edge.source,
          port: edge.sourcePort,
          status: active ? "succeeded" : "skipped",
          value: active ? (step?.output ?? null) : null,
        };
      }),
    };
  }
  const active = incoming.filter((edge) => classify(doc, edge, steps) === "active");
  const first = active[0];
  if (first) return steps.get(first.source)?.output ?? null;
  if (scope && node.iterationParent === scope.parentId && incoming.length === 0) {
    return { item: scope.item, index: scope.index };
  }
  return null;
}

export function buildContext(args: {
  doc: WorkflowDocument;
  steps: StepSnapshot[];
  input: unknown;
  item?: unknown;
  index?: number;
  trigger?: unknown;
  extraNodes?: Record<string, unknown>;
}): Record<string, unknown> {
  const triggerNode = args.doc.nodes.find((node) => isTrigger(node.type) && !node.iterationParent);
  const triggerStep = triggerNode ? args.steps.find((step) => step.nodeId === triggerNode.id) : undefined;
  const nodes: Record<string, unknown> = { ...(args.extraNodes ?? {}) };
  for (const step of args.steps) {
    if (step.status === "succeeded") nodes[step.nodeId] = step.output;
  }
  return {
    trigger: args.trigger ?? triggerStep?.output ?? null,
    nodes,
    input: args.input,
    item: args.item ?? null,
    index: args.index ?? null,
  };
}

function skipReason(doc: WorkflowDocument, incoming: WorkflowEdge[], steps: Map<string, StepSnapshot>): string {
  for (const edge of incoming) {
    const step = steps.get(edge.source);
    const source = doc.nodes.find((node) => node.id === edge.source);
    if (step?.status === "succeeded" && source?.type === "condition" && step.selectedPort !== edge.sourcePort) {
      return "branch_not_selected";
    }
  }
  return "upstream_skipped";
}

export function planGraph(args: { doc: WorkflowDocument; steps: StepSnapshot[]; scope?: PlanScope; cancelRequested?: boolean }): PlanResult {
  const scopeNodes = args.doc.nodes.filter((node) => inScope(node, args.scope)).sort((a, b) => a.id.localeCompare(b.id));
  const scopeIds = new Set(scopeNodes.map((node) => node.id));
  const virtual = new Map(args.steps.filter((step) => scopeIds.has(step.nodeId)).map((step) => [step.nodeId, step]));
  const parallelism = args.scope ? 1 : args.doc.settings.parallelism;
  const scoped = () => [...virtual.values()];

  if (!args.scope) {
    const triggers = scopeNodes.filter((node) => isTrigger(node.type));
    if (triggers.length === 0 || triggers.some((node) => !virtual.has(node.id))) {
      return {
        create: [],
        cancel: [],
        finish: { status: "failed", code: "trigger_missing", message: "The run has no trigger step." },
        runStatus: "failed",
      };
    }
  }

  const cancelRequested = args.cancelRequested || scoped().some((step) => step.status === "canceled");
  if (cancelRequested) {
    const cancel = scoped().filter((step) => step.status === "queued" || step.status === "waiting").map((step) => step.nodeId);
    const running = scoped().some((step) => step.status === "running");
    return {
      create: [],
      cancel,
      finish: running ? undefined : { status: "canceled", code: "canceled", message: "Run canceled. Completed external actions were not reversed." },
      runStatus: running ? "running" : "canceled",
    };
  }

  const failed = scoped().find((step) => step.status === "failed");
  if (failed) {
    const cancel = scoped().filter((step) => step.status === "queued" || step.status === "waiting").map((step) => step.nodeId);
    const running = scoped().some((step) => step.status === "running");
    return {
      create: [],
      cancel,
      finish: running
        ? undefined
        : {
            status: "failed",
            code: failed.error?.code ?? "step_failed",
            message: failed.error?.message ?? `Step ${failed.nodeId} failed.`,
          },
      runStatus: running ? "running" : "failed",
    };
  }

  const created: PlannedStep[] = [];
  let guard = 0;
  while (guard < scopeNodes.length + 4) {
    guard += 1;
    let progress = false;
    let inflight = scoped().filter((step) => step.status === "queued" || step.status === "running").length;
    for (const node of scopeNodes) {
      if (virtual.has(node.id)) continue;
      if (!args.scope && isTrigger(node.type)) continue;
      const incoming = args.doc.edges.filter((edge) => edge.target === node.id && scopeIds.has(edge.source));
      if (incoming.length === 0) {
        if (!args.scope) continue;
        if (inflight >= parallelism) continue;
        const input = buildNodeInput(args.doc, node, virtual, args.scope);
        const planned: PlannedStep = { nodeId: node.id, nodeType: node.type, status: "queued", input };
        created.push(planned);
        virtual.set(node.id, { nodeId: node.id, nodeType: node.type, status: "queued", input, attempt: 0 });
        inflight += 1;
        progress = true;
        continue;
      }
      const classes = incoming.map((edge) => classify(args.doc, edge, virtual));
      if (classes.some((entry) => entry === "pending" || entry === "blocked")) continue;
      if (classes.every((entry) => entry === "inactive")) {
        const planned: PlannedStep = {
          nodeId: node.id,
          nodeType: node.type,
          status: "skipped",
          input: null,
          reason: skipReason(args.doc, incoming, virtual),
        };
        created.push(planned);
        virtual.set(node.id, { nodeId: node.id, nodeType: node.type, status: "skipped", attempt: 0 });
        progress = true;
        continue;
      }
      if (inflight >= parallelism) continue;
      const input = buildNodeInput(args.doc, node, virtual, args.scope);
      const planned: PlannedStep = { nodeId: node.id, nodeType: node.type, status: "queued", input };
      created.push(planned);
      virtual.set(node.id, { nodeId: node.id, nodeType: node.type, status: "queued", input, attempt: 0 });
      inflight += 1;
      progress = true;
    }
    if (!progress) break;
  }

  const absent = scopeNodes.filter((node) => !virtual.has(node.id));
  const inflight = scoped().some((step) => step.status === "queued" || step.status === "running");
  const waiting = scoped().some((step) => step.status === "waiting");
  if (!inflight && !waiting && absent.length === 0 && scopeNodes.every((node) => {
    const step = virtual.get(node.id);
    return step?.status === "succeeded" || step?.status === "skipped";
  })) {
    return { create: created, cancel: [], finish: { status: "succeeded" }, runStatus: "succeeded" };
  }
  if (!inflight && !waiting && absent.length > 0) {
    return {
      create: created,
      cancel: [],
      finish: {
        status: "failed",
        code: "stalled",
        message: `No ready node remains: ${absent.map((node) => node.id).join(", ")}.`,
      },
      runStatus: "failed",
    };
  }
  return { create: created, cancel: [], runStatus: waiting && !inflight ? "waiting" : "running" };
}
