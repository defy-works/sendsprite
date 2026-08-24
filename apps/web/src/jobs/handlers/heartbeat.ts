export async function heartbeat() {
  // Proves the worker loop is alive; visible in logs and used by e2e.
  console.info(`[worker] heartbeat ${new Date().toISOString()}`);
}
