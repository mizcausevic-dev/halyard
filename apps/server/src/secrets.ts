import { decryptJson, secretStrings } from "./crypto.js";
import { getPool } from "./db.js";

export async function workspaceSecrets(workspaceId: string): Promise<string[]> {
  const result = await getPool().query<{ ciphertext: string }>("SELECT ciphertext FROM credentials WHERE workspace_id = $1", [workspaceId]);
  const secrets: string[] = [];
  for (const row of result.rows) {
    try {
      secrets.push(...secretStrings(decryptJson(row.ciphertext)));
    } catch {
      /* Missing key versions are skipped for redaction and fail closed at use. */
    }
  }
  return secrets;
}
