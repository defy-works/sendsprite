/**
 * Runs once per Next.js server process (nodejs runtime only).
 * 1. With NEXT_MANUAL_SIG_HANDLE=true (set in the Docker image), take over
 *    SIGTERM/SIGINT so `docker stop` exits promptly in every WORKER_MODE:
 *    the worker (if any) is stopped gracefully first, then the process exits.
 * 2. Apply DB migrations (safe/idempotent, advisory-locked).
 * 3. Start the in-process job worker unless WORKER_MODE says otherwise.
 * 4. Start the SMTP relay when SMTP_ENABLED: it is part of the web tier, so
 *    it runs in every WORKER_MODE. A busy port is logged, not fatal; a bad
 *    SMTP_TLS_CERT/KEY path is a configuration error and aborts boot.
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
    const { startSmtp } = await import("@/smtp/server");
    const { loadOrGenerateCert } = await import("@/smtp/tls");
    const tls = await loadOrGenerateCert({
      cert: env.SMTP_TLS_CERT,
      key: env.SMTP_TLS_KEY,
    });
    try {
      await startSmtp({
        port: env.SMTP_PORT,
        maxSize: env.SMTP_MAX_SIZE,
        allowInsecureAuth: env.SMTP_ALLOW_INSECURE_AUTH,
        tls,
      });
    } catch (e) {
      if ((e as { code?: string })?.code !== "EADDRINUSE") throw e;
      console.error(
        `[smtp] port ${env.SMTP_PORT} is in use; relay not started`,
      );
    }
  }
}
