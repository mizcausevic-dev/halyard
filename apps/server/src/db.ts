import pg from "pg";
import { loadConfig } from "./env.js";

let singleton: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!singleton) {
    const config = loadConfig();
    singleton = new pg.Pool({ connectionString: config.databaseUrl, max: 12 });
  }
  return singleton;
}

export async function closePool(): Promise<void> {
  if (!singleton) return;
  const current = singleton;
  singleton = null;
  await current.end();
}

export type Db = pg.PoolClient;

export async function withTx<T>(fn: (client: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* The connection may already be closed. */
    }
    throw error;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  if (error.code !== "23505") return false;
  if (!constraint) return true;
  return "constraint" in error && error.constraint === constraint;
}
