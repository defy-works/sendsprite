/**
 * Runs once per Next.js server process (nodejs runtime only).
 * 1. Apply DB migrations (safe/idempotent, advisory-locked).
 * 2. Start the in-process job worker unless WORKER_MODE says otherwise.
 * 3. With NEXT_MANUAL_SIG_HANDLE=true (set in the Docker image), stop the
 *    worker gracefully on SIGTERM/SIGINT before exiting.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadEnv } = await import("@/env.schema");
  const { runMigrations } = await import("@/db/migrate");
  const env = loadEnv();
  await runMigrations(env.DATABASE_URL);
  console.info("[boot] migrations applied");
  if (env.WORKER_MODE !== "inline") return;

  const { startWorker } = await import("@/jobs/boss");
  await startWorker();

  if (process.env.NEXT_MANUAL_SIG_HANDLE === "true") {
    const { installShutdownHandlers } = await import("@/jobs/shutdown");
    installShutdownHandlers();
  }
}
