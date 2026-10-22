import { closePool } from "./db.js";
import { claimJob, handleJob, reclaimExpired } from "./engine.js";
import { loadConfig } from "./env.js";
import { migrate } from "./migrate.js";
import { fireDueSchedules } from "./scheduler.js";

const config = loadConfig();
await migrate();
const workerId = process.env.WORKER_ID || `halyard-${process.pid}`;
let stop = false;

process.on("SIGTERM", () => {
  stop = true;
});
process.on("SIGINT", () => {
  stop = true;
});

async function loop(name: string): Promise<void> {
  while (!stop) {
    try {
      await reclaimExpired();
      await fireDueSchedules();
      const job = await claimJob(name);
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, config.pollMs));
        continue;
      }
      await handleJob(job, name);
    } catch (error) {
      console.log(JSON.stringify({ level: "error", message: "worker tick failed", worker: name, error: error instanceof Error ? error.message : "error" }));
      await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    }
  }
}

const count = Math.max(1, config.concurrency);
await Promise.all(Array.from({ length: count }, (_, index) => loop(`${workerId}-${index}`)));
await closePool();
