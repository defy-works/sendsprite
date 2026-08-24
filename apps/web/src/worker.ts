// Standalone worker process for WORKER_MODE=separate (`bun run worker`).
import { loadEnv } from "@/env.schema";
import { runMigrations } from "@/db/migrate";
import { startWorker, stopWorker } from "@/jobs/boss";

const env = loadEnv();
await runMigrations(env.DATABASE_URL);
await startWorker();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await stopWorker();
    process.exit(0);
  });
}
