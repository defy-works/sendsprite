// Standalone worker process for WORKER_MODE=separate (`bun run worker`).
import { loadEnv } from "@/env.schema";
import { runMigrations } from "@/db/migrate";
import { startWorker } from "@/jobs/boss";
import { installShutdownHandlers } from "@/jobs/shutdown";

const env = loadEnv();
await runMigrations(env.DATABASE_URL);
await startWorker();
installShutdownHandlers();
