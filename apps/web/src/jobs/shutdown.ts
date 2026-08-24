import { stopWorker } from "./boss";

/**
 * Stop the worker gracefully on SIGTERM/SIGINT, then exit. A second signal
 * while stopping exits immediately. Kept out of instrumentation.ts because
 * Next also compiles that file for the Edge runtime and flags `process.on`.
 */
export function installShutdownHandlers() {
  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, async () => {
      if (stopping) process.exit(1);
      stopping = true;
      try {
        await stopWorker();
      } finally {
        process.exit(0);
      }
    });
  }
}
