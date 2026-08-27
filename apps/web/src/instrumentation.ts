/**
 * Runs once per Next.js server process (nodejs runtime only).
 * 1. With NEXT_MANUAL_SIG_HANDLE=true (set in the Docker image), take over
 *    SIGTERM/SIGINT so `docker stop` exits promptly in every WORKER_MODE:
 *    the worker (if any) is stopped gracefully first, then the process exits.
 * 2. Apply DB migrations (safe/idempotent, advisory-locked).
 * 3. Start the in-process job worker unless WORKER_MODE says otherwise.
 * 4. Start the SMTP relay when SMTP_ENABLED: it is part of the web tier, so
 *    it runs in every WORKER_MODE. It is optional, so no relay failure is
 *    fatal — `startRelay` logs it and /api/health reports it; the dashboard
 *    and the REST API keep serving. Steps 2 and 3 stay fatal: without
 *    migrations or the worker this instance cannot do its job at all.
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
  if (env.WORKER_MODE === "inline") {
    const { startWorker } = await import("@/jobs/boss");
    await startWorker();
  }
  if (env.SMTP_ENABLED) {
    const { startRelay } = await import("@/smtp/boot");
    await startRelay({
      port: env.SMTP_PORT,
      maxSize: env.SMTP_MAX_SIZE,
      allowInsecureAuth: env.SMTP_ALLOW_INSECURE_AUTH,
      tlsCert: env.SMTP_TLS_CERT,
      tlsKey: env.SMTP_TLS_KEY,
    });
  }
}
