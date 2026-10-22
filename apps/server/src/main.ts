import { createServer } from "node:http";
import { closePool } from "./db.js";
import { loadConfig } from "./env.js";
import { createHandler } from "./httpapp.js";
import { migrate } from "./migrate.js";

const config = loadConfig();
await migrate();
const server = createServer(createHandler(config.staticDir));
server.listen(config.port, "127.0.0.1", () => {
  console.log(JSON.stringify({ message: "halyard api listening", port: config.port }));
});

async function shutdown(): Promise<void> {
  server.close();
  await closePool();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
