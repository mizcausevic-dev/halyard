import { spawn } from "node:child_process";
import { loadConfig } from "../apps/server/src/env.js";

loadConfig();
const children = [
  spawn("npx", ["tsx", "apps/fixture/src/main.ts"], { stdio: "inherit" }),
  spawn("npx", ["tsx", "apps/server/src/main.ts"], { stdio: "inherit" }),
  spawn("npx", ["tsx", "apps/server/src/worker.ts"], { stdio: "inherit" }),
  spawn("npx", ["vite", "--config", "apps/web/vite.config.ts"], { stdio: "inherit" }),
];

function stop() {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => undefined);
