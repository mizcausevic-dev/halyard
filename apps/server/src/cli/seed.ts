import { EXAMPLE_CREDENTIAL_ID, exampleDocuments } from "@halyard/core";
import { createUser } from "../auth.js";
import { encryptJson } from "../crypto.js";
import { closePool, getPool } from "../db.js";
import { loadConfig } from "../env.js";
import { migrate } from "../migrate.js";
import { publishWorkflow, createWorkflow } from "../workflows.js";

loadConfig();
await migrate();
const email = (process.env.DEMO_USER_EMAIL ?? "ada@halyard.dev").toLowerCase();
const password = process.env.DEMO_USER_PASSWORD ?? "halyard-dev-password";
const name = process.env.DEMO_USER_NAME ?? "Ada Quartermain";
let user = (await getPool().query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email])).rows[0];
if (!user) user = await createUser(email, name, password);
const workspace = (await getPool().query<{ id: string }>("SELECT id FROM workspaces WHERE slug = 'studio'")).rows[0]
  ?? (await getPool().query<{ id: string }>("INSERT INTO workspaces (name, slug) VALUES ('Studio', 'studio') RETURNING id")).rows[0];
if (!workspace) throw new Error("Workspace seed failed.");
await getPool().query(
  `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')
   ON CONFLICT (workspace_id, user_id) DO NOTHING`,
  [workspace.id, user.id],
);
const encrypted = encryptJson({ value: "hook-secret" });
await getPool().query(
  `INSERT INTO credentials (id, workspace_id, name, kind, ciphertext, key_version)
   VALUES ($1, $2, 'Order webhook', 'shared_secret', $3, $4)
   ON CONFLICT (id) DO NOTHING`,
  [EXAMPLE_CREDENTIAL_ID, workspace.id, encrypted.ciphertext, encrypted.keyVersion],
);
const examples = exampleDocuments(process.env.FIXTURE_BASE_URL ?? "http://127.0.0.1:4099");
for (const document of [examples.intake, examples.digest, examples.batch]) {
  const existing = await getPool().query("SELECT id FROM workflows WHERE workspace_id = $1 AND name = $2", [workspace.id, document.name]);
  if ((existing.rowCount ?? 0) > 0) continue;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const created = await createWorkflow(client, workspace.id, document.name, document.description, document);
    await publishWorkflow(client, workspace.id, created.workflow.id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
console.log(JSON.stringify({ seeded: true, email, workspace: "studio", webhookSecret: "hook-secret" }));
await closePool();
