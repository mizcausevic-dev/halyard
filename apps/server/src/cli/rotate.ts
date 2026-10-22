import { decryptJson, encryptJson, currentKey } from "../crypto.js";
import { closePool, getPool } from "../db.js";
import { loadConfig } from "../env.js";

loadConfig();
const current = currentKey();
const rows = await getPool().query<{ id: string; ciphertext: string; key_version: number }>("SELECT id, ciphertext, key_version FROM credentials");
let rotated = 0;
for (const row of rows.rows) {
  if (row.key_version === current.version) continue;
  const plain = decryptJson(row.ciphertext);
  const next = encryptJson(plain);
  await getPool().query("UPDATE credentials SET ciphertext = $2, key_version = $3, updated_at = now() WHERE id = $1", [row.id, next.ciphertext, next.keyVersion]);
  rotated += 1;
}
console.log(JSON.stringify({ rotated, keyVersion: current.version, scanned: rows.rowCount }));
await closePool();
