import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEV_KEY = "aGFseWFyZC1kZXYta2V5LW5vdC1mb3ItcHJvZCEhISE=";

export type AppConfig = {
  env: string;
  databaseUrl: string;
  port: number;
  origins: string[];
  allowHosts: string[];
  leaseMs: number;
  pollMs: number;
  concurrency: number;
  staticDir: string | null;
};

let loaded = false;

export function loadDotEnv(path = resolve(process.cwd(), ".env")): void {
  if (loaded || !existsSync(path)) {
    loaded = true;
    return;
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  loaded = true;
}

export function loadConfig(): AppConfig {
  loadDotEnv();
  const env = process.env.HALYARD_ENV ?? "production";
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!key) throw new Error("CREDENTIAL_ENCRYPTION_KEY is required.");
  if (Buffer.from(key, "base64").length !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  }
  if (env === "production" && key === DEV_KEY) {
    throw new Error("Refusing the published sample encryption key when HALYARD_ENV=production.");
  }
  if (env === "production" && process.env.HALYARD_SSRF_ALLOW_HOSTS) {
    throw new Error("Unset HALYARD_SSRF_ALLOW_HOSTS when HALYARD_ENV=production.");
  }
  const allowHosts = env === "production"
    ? []
    : (process.env.HALYARD_SSRF_ALLOW_HOSTS ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return {
    env,
    databaseUrl,
    port: Number(process.env.API_PORT ?? 8787),
    origins: (process.env.HALYARD_ORIGIN ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
    allowHosts,
    leaseMs: Number(process.env.WORKER_LEASE_MS ?? 30_000),
    pollMs: Number(process.env.WORKER_POLL_MS ?? 400),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
    staticDir: process.env.HALYARD_STATIC_DIR ?? null,
  };
}
