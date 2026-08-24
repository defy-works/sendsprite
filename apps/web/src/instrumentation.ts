/**
 * Runs once per Next.js server process (nodejs runtime only).
 * 1. With NEXT_MANUAL_SIG_HANDLE=true (set in the Docker image), take over
 *    SIGTERM/SIGINT so `docker stop` exits promptly in every WORKER_MODE:
 *    the worker (if any) is stopped gracefully first, then the process exits.
 * 2. Apply DB migrations (safe/idempotent, advisory-locked).
 * 3. Start the in-process job worker unless WORKER_MODE says otherwise.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env.NEXT_MANUAL_SIG_HANDLE === "true") {
    const { installShutdownHandlers } = await import("@/jobs/shutdown");
    installShutdownHandlers();
  }

  const { loadEnv } = await import("@/env.schema");
  const { runMigrations } = await import("@/db/migrate");
  const env = loadEnv();
  await runMigrations(env.DATABASE_URL);
  console.info("[boot] migrations applied");
  if (env.WORKER_MODE !== "inline") return;

  const { startWorker } = await import("@/jobs/boss");
  await startWorker();
}
