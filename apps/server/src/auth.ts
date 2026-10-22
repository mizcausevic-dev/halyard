import { createHash, randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "./crypto.js";
import { getPool } from "./db.js";

export type SessionUser = { id: string; email: string; name: string };

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function login(email: string, password: string): Promise<{ token: string; user: SessionUser } | null> {
  const result = await getPool().query<{ id: string; email: string; name: string; password_hash: string }>("SELECT id, email, name, password_hash FROM users WHERE email = $1", [email.toLowerCase()]);
  const user = result.rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) return null;
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await getPool().query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)", [user.id, tokenHash(token), expires]);
  return { token, user: { id: user.id, email: user.email, name: user.name } };
}

export async function logout(token: string | null): Promise<void> {
  if (!token) return;
  await getPool().query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
}

export async function userFromToken(token: string | null): Promise<SessionUser | null> {
  if (!token) return null;
  const result = await getPool().query<SessionUser>(
    `SELECT u.id, u.email, u.name
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash(token)],
  );
  return result.rows[0] ?? null;
}

export async function createUser(email: string, name: string, password: string): Promise<SessionUser> {
  if (password.length < 10) throw new Error("Password must be at least 10 characters.");
  const passwordHash = await hashPassword(password);
  const result = await getPool().query<SessionUser>(
    "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name",
    [email.toLowerCase(), name, passwordHash],
  );
  const user = result.rows[0];
  if (!user) throw new Error("User insert failed.");
  return user;
}
