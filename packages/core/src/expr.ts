import { LIMITS } from "./limits.js";
import type { Expr } from "./types.js";

export class ExprError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExprError";
    this.code = code;
  }
}

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

export function parseExpr(input: unknown, depth = 0): Expr {
  if (depth > LIMITS.maxExprDepth) {
    throw new ExprError("expr_depth", "Expression is nested deeper than the limit.");
  }
  if (!isRecord(input) || typeof input.op !== "string") {
    throw new ExprError("expr_shape", "An expression must be an object with an op.");
  }
  const op = input.op;
  const extra = (allowed: string[]) => {
    const bad = unknownKeys(input, allowed);
    if (bad.length > 0) {
      throw new ExprError("expr_key", `Unsupported expression field: ${bad.join(", ")}.`);
    }
  };
  const child = (value: unknown) => parseExpr(value, depth + 1);
  switch (op) {
    case "lit": {
      extra(["op", "value"]);
      const value = input.value;
      if (value === null || typeof value === "boolean") return { op, value };
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new ExprError("expr_lit", "Literal numbers must be finite.");
        return { op, value };
      }
      if (typeof value === "string") {
        if (value.length > LIMITS.maxStringLength) {
          throw new ExprError("expr_lit", "Literal string exceeds the length limit.");
        }
        return { op, value };
      }
      throw new ExprError("expr_lit", "Literal values must be a string, number, boolean, or null.");
    }
    case "get": {
      extra(["op", "path"]);
      if (typeof input.path !== "string" || input.path.length === 0 || input.path.length > 256) {
        throw new ExprError("expr_path", "A get expression needs a path.");
      }
      const parts = input.path.split(".");
      if (parts.length > LIMITS.maxPathSegments) {
        throw new ExprError("expr_path", "Path has too many segments.");
      }
      for (const part of parts) {
        if (part.length === 0 || part.length > 64 || FORBIDDEN.has(part)) {
          throw new ExprError("expr_path", "Path contains an unsupported segment.");
        }
      }
      return { op, path: input.path };
    }
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "add":
    case "sub":
    case "mul":
    case "div":
      extra(["op", "left", "right"]);
      return { op, left: child(input.left), right: child(input.right) };
    case "and":
    case "or":
    case "concat":
    case "coalesce": {
      extra(["op", "args"]);
      if (!Array.isArray(input.args) || input.args.length < 1 || input.args.length > 20) {
        throw new ExprError("expr_args", `${op} needs between 1 and 20 arguments.`);
      }
      return { op, args: input.args.map((entry) => child(entry)) };
    }
    case "not":
    case "lower":
    case "upper":
    case "trim":
    case "length":
      extra(["op", "arg"]);
      return { op, arg: child(input.arg) };
    case "contains":
      extra(["op", "value", "search"]);
      return { op, value: child(input.value), search: child(input.search) };
    case "if":
      extra(["op", "cond", "then", "else"]);
      return { op: "if", cond: child(input.cond), then: child(input.then), else: child(input.else) };
    case "object": {
      extra(["op", "entries"]);
      if (!Array.isArray(input.entries) || input.entries.length > 50) {
        throw new ExprError("expr_object", "Object expressions need an entries array of at most 50.");
      }
      const entries = input.entries.map((entry) => {
        if (!isRecord(entry)) throw new ExprError("expr_object", "Object entry must be an object.");
        const bad = unknownKeys(entry, ["key", "value"]);
        if (bad.length > 0) throw new ExprError("expr_key", `Unsupported entry field: ${bad.join(", ")}.`);
        if (typeof entry.key !== "string" || !KEY.test(entry.key) || FORBIDDEN.has(entry.key)) {
          throw new ExprError("expr_object", "Object key is not allowed.");
        }
        return { key: entry.key, value: child(entry.value) };
      });
      return { op, entries };
    }
    default:
      throw new ExprError("expr_op", `Unsupported expression op: ${op}.`);
  }
}

type Budget = { steps: number };

function spend(budget: Budget, depth: number): void {
  if (depth > LIMITS.maxExprDepth) throw new ExprError("expr_depth", "Expression is nested deeper than the limit.");
  budget.steps += 1;
  if (budget.steps > LIMITS.maxExprSteps) {
    throw new ExprError("expr_steps", "Expression exceeded the step limit.");
  }
}

function boundedString(value: string): string {
  if (value.length > LIMITS.maxStringLength) {
    throw new ExprError("expr_length", "String result exceeds the length limit.");
  }
  return value;
}

export function safeGet(root: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = root;
  for (const part of parts) {
    if (FORBIDDEN.has(part)) throw new ExprError("expr_path", "Path contains an unsupported segment.");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(part)) return undefined;
      const index = Number(part);
      if (index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function evalInner(expr: Expr, root: unknown, budget: Budget, depth: number): unknown {
  spend(budget, depth);
  switch (expr.op) {
    case "lit":
      return expr.value;
    case "get":
      return safeGet(root, expr.path);
    case "eq":
      return evalInner(expr.left, root, budget, depth + 1) === evalInner(expr.right, root, budget, depth + 1);
    case "neq":
      return evalInner(expr.left, root, budget, depth + 1) !== evalInner(expr.right, root, budget, depth + 1);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const left = asNumber(evalInner(expr.left, root, budget, depth + 1));
      const right = asNumber(evalInner(expr.right, root, budget, depth + 1));
      if (left === undefined || right === undefined) return false;
      if (expr.op === "gt") return left > right;
      if (expr.op === "gte") return left >= right;
      if (expr.op === "lt") return left < right;
      return left <= right;
    }
    case "and": {
      for (const arg of expr.args) {
        const value = evalInner(arg, root, budget, depth + 1);
        if (typeof value !== "boolean") throw new ExprError("expr_type", "and expects booleans.");
        if (!value) return false;
      }
      return true;
    }
    case "or": {
      for (const arg of expr.args) {
        const value = evalInner(arg, root, budget, depth + 1);
        if (typeof value !== "boolean") throw new ExprError("expr_type", "or expects booleans.");
        if (value) return true;
      }
      return false;
    }
    case "not": {
      const value = evalInner(expr.arg, root, budget, depth + 1);
      if (typeof value !== "boolean") throw new ExprError("expr_type", "not expects a boolean.");
      return !value;
    }
    case "add":
    case "sub":
    case "mul":
    case "div": {
      const left = asNumber(evalInner(expr.left, root, budget, depth + 1));
      const right = asNumber(evalInner(expr.right, root, budget, depth + 1));
      if (left === undefined || right === undefined) {
        throw new ExprError("expr_type", "Arithmetic expects finite numbers.");
      }
      if (expr.op === "div" && right === 0) throw new ExprError("expr_div", "Division by zero.");
      const value = expr.op === "add" ? left + right : expr.op === "sub" ? left - right : expr.op === "mul" ? left * right : left / right;
      if (!Number.isFinite(value)) throw new ExprError("expr_type", "Arithmetic result is not finite.");
      return value;
    }
    case "concat": {
      const parts = expr.args.map((arg) => {
        const value = evalInner(arg, root, budget, depth + 1);
        if (value === null || value === undefined) return "";
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
        throw new ExprError("expr_type", "concat expects scalar values.");
      });
      return boundedString(parts.join(""));
    }
    case "lower":
    case "upper":
    case "trim": {
      const value = evalInner(expr.arg, root, budget, depth + 1);
      if (typeof value !== "string") throw new ExprError("expr_type", `${expr.op} expects a string.`);
      const next = expr.op === "lower" ? value.toLowerCase() : expr.op === "upper" ? value.toUpperCase() : value.trim();
      return boundedString(next);
    }
    case "contains": {
      const value = evalInner(expr.value, root, budget, depth + 1);
      const search = evalInner(expr.search, root, budget, depth + 1);
      if (typeof value !== "string" || typeof search !== "string") return false;
      return value.includes(search);
    }
    case "coalesce": {
      for (const arg of expr.args) {
        const value = evalInner(arg, root, budget, depth + 1);
        if (value !== null && value !== undefined) return value;
      }
      return null;
    }
    case "length": {
      const value = evalInner(expr.arg, root, budget, depth + 1);
      if (typeof value === "string" || Array.isArray(value)) return value.length;
      throw new ExprError("expr_type", "length expects a string or an array.");
    }
    case "if": {
      const cond = evalInner(expr.cond, root, budget, depth + 1);
      if (typeof cond !== "boolean") throw new ExprError("expr_type", "if condition must be a boolean.");
      return evalInner(cond ? expr.then : expr.else, root, budget, depth + 1);
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const entry of expr.entries) {
        if (FORBIDDEN.has(entry.key)) throw new ExprError("expr_object", "Object key is not allowed.");
        out[entry.key] = evalInner(entry.value, root, budget, depth + 1);
      }
      return out;
    }
    default: {
      const neverOp: never = expr;
      throw new ExprError("expr_op", `Unsupported expression op: ${String(neverOp)}.`);
    }
  }
}

export function evalExpr(expr: Expr, root: unknown): unknown {
  return evalInner(expr, root, { steps: 0 }, 0);
}
