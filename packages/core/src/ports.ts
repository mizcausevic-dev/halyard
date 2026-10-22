import type { NodeType } from "./types.js";

export type PortDef = {
  id: string;
  direction: "in" | "out";
  required?: boolean;
  multiple?: boolean;
};

export const PORTS: Record<NodeType, PortDef[]> = {
  manual_trigger: [{ id: "out", direction: "out" }],
  schedule_trigger: [{ id: "out", direction: "out" }],
  webhook_trigger: [{ id: "out", direction: "out" }],
  http_request: [
    { id: "in", direction: "in", required: true },
    { id: "out", direction: "out" },
  ],
  condition: [
    { id: "in", direction: "in", required: true },
    { id: "true", direction: "out" },
    { id: "false", direction: "out" },
  ],
  map_fields: [
    { id: "in", direction: "in", required: true },
    { id: "out", direction: "out" },
  ],
  iterate: [
    { id: "in", direction: "in", required: true },
    { id: "out", direction: "out" },
  ],
  delay: [
    { id: "in", direction: "in", required: true },
    { id: "out", direction: "out" },
  ],
  transform: [
    { id: "in", direction: "in", required: true },
    { id: "out", direction: "out" },
  ],
  merge: [
    { id: "in", direction: "in", required: true, multiple: true },
    { id: "out", direction: "out" },
  ],
  output: [{ id: "in", direction: "in", required: true }],
};

export function findPort(type: NodeType, id: string, direction: "in" | "out"): PortDef | undefined {
  return PORTS[type].find((port) => port.id === id && port.direction === direction);
}
