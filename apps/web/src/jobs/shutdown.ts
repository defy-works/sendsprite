import { stopWorker } from "./boss";
import { stopSmtp } from "@/smtp/server";

/**
 * Stop the SMTP relay and the worker on SIGTERM/SIGINT, then exit. When no worker
 * was started (WORKER_MODE=none/separate) this is just a prompt exit, which
 * matters under NEXT_MANUAL_SIG_HANDLE=true: Next no longer exits on its
 * own, so without a handler `docker stop` would wait for SIGKILL. A second
 * signal while stopping exits immediately. Kept out of instrumentation.ts
 * because Next also compiles that file for the Edge runtime and flags
 * `process.on`.
 */
export function installShutdownHandlers() {
  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, async () => {
      if (stopping) process.exit(1);
      stopping = true;
      try {
        await stopSmtp();
        await stopWorker();
      } finally {
        process.exit(0);
      }
    });
  }
}
