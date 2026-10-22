import { findPort } from "./ports.js";
import type { ValidationIssue, WorkflowDocument, WorkflowNode } from "./types.js";

export function connectionIssue(
  doc: WorkflowDocument,
  draft: { source: string; sourcePort: string; target: string; targetPort: string },
): ValidationIssue | null {
  const source = doc.nodes.find((node) => node.id === draft.source);
  const target = doc.nodes.find((node) => node.id === draft.target);
  if (!source || !target) {
    return { level: "error", code: "edge_endpoint", message: "Connect two nodes that are on the canvas." };
  }
  if (source.id === target.id) {
    return { level: "error", code: "cycle", message: "A node cannot connect to itself." };
  }
  if ((source.iterationParent ?? null) !== (target.iterationParent ?? null)) {
    return { level: "error", code: "edge_scope", message: "Edges stay inside the iteration body, or outside it." };
  }
  if (!findPort(source.type, draft.sourcePort, "out")) {
    return { level: "error", code: "port", message: `${source.name} has no output port ${draft.sourcePort}.`, nodeId: source.id };
  }
  const input = findPort(target.type, draft.targetPort, "in");
  if (!input) {
    return { level: "error", code: "port", message: `${target.name} has no input port ${draft.targetPort}.`, nodeId: target.id };
  }
  const existing = doc.edges.filter((edge) => edge.target === target.id && edge.targetPort === draft.targetPort);
  if (!input.multiple && existing.length > 0) {
    return { level: "error", code: "port_cardinality", message: `${target.name} already has a connection on ${draft.targetPort}.`, nodeId: target.id };
  }
  const scope = source.iterationParent ?? null;
  const nodes = doc.nodes.filter((node) => (node.iterationParent ?? null) === scope);
  const edges = doc.edges
    .filter((edge) => nodes.some((node) => node.id === edge.source) && nodes.some((node) => node.id === edge.target))
    .map((edge) => ({ source: edge.source, target: edge.target }));
  edges.push({ source: source.id, target: target.id });
  if (hasCycle(nodes.map((node) => node.id), edges)) {
    return { level: "error", code: "cycle", message: "That connection would create a cycle. Iteration is the only loop, and it is a node, not a back-edge." };
  }
  return null;
}

function hasCycle(ids: string[], edges: { source: string; target: string }[]): boolean {
  const adjacent = new Map<string, string[]>();
  for (const id of ids) adjacent.set(id, []);
  for (const edge of edges) adjacent.get(edge.source)?.push(edge.target);
  const color = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    color.set(id, 1);
    for (const next of adjacent.get(id) ?? []) {
      const state = color.get(next) ?? 0;
      if (state === 1) return true;
      if (state === 0 && visit(next)) return true;
    }
    color.set(id, 2);
    return false;
  };
  return ids.some((id) => (color.get(id) ?? 0) === 0 && visit(id));
}

export function layoutDocument(doc: WorkflowDocument): WorkflowDocument {
  const positions = new Map<string, { x: number; y: number }>();
  place(doc.nodes.filter((node) => !node.iterationParent), doc, 48, 48, positions);
  for (const parent of doc.nodes.filter((node) => node.type === "iterate")) {
    const origin = positions.get(parent.id) ?? parent.position;
    const body = doc.nodes.filter((node) => node.iterationParent === parent.id);
    place(body, doc, origin.x + 300, origin.y + 170, positions);
  }
  return {
    ...doc,
    nodes: doc.nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })),
  };
}

function place(nodes: WorkflowNode[], doc: WorkflowDocument, originX: number, originY: number, positions: Map<string, { x: number; y: number }>): void {
  const ids = new Set(nodes.map((node) => node.id));
  const incoming = new Map<string, number>();
  const adjacent = new Map<string, string[]>();
  for (const id of ids) {
    incoming.set(id, 0);
    adjacent.set(id, []);
  }
  for (const edge of doc.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    adjacent.get(edge.source)?.push(edge.target);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }
  const depth = new Map<string, number>();
  const queue = [...ids].filter((id) => (incoming.get(id) ?? 0) === 0).sort();
  for (const id of queue) depth.set(id, 0);
  const pending = new Map(incoming);
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) break;
    for (const next of adjacent.get(id) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, (depth.get(id) ?? 0) + 1));
      pending.set(next, (pending.get(next) ?? 1) - 1);
      if (pending.get(next) === 0) queue.push(next);
    }
  }
  const layers = new Map<number, string[]>();
  for (const node of nodes) {
    const layer = depth.get(node.id);
    if (layer === undefined) continue;
    const list = layers.get(layer) ?? [];
    list.push(node.id);
    layers.set(layer, list);
  }
  for (const layer of [...layers.keys()].sort((a, b) => a - b)) {
    const list = (layers.get(layer) ?? []).sort();
    list.forEach((id, index) => {
      positions.set(id, { x: originX + layer * 280, y: originY + index * 148 });
    });
  }
}
