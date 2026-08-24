/**
 * Runs once per Next.js server process (nodejs runtime only).
 * 1. Apply DB migrations (safe/idempotent).
 * 2. Start the in-process job worker unless WORKER_MODE says otherwise.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadEnv } = await import("@/env.schema");
  const { runMigrations } = await import("@/db/migrate");
  const env = loadEnv();
  await runMigrations(env.DATABASE_URL);
  console.info("[boot] migrations applied");
  if (env.WORKER_MODE === "inline") {
    const { startWorker } = await import("@/jobs/boss");
    await startWorker();
  }
}
