import os from "node:os";
import { lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { workerHeartbeats } from "@/db/schema";
import { registerQueue } from "../boss";
import { Q } from "../queues";

export const PROCESS_ID = `${os.hostname()}:${process.pid}`;
const PRUNE_AFTER_MS = 24 * 3600 * 1000;

/**
 * Proves the worker loop is alive: logs, and upserts this process's row in
 * `worker_heartbeats` so a web container with WORKER_MODE=separate can
 * report the worker's health (lib/health.ts). Rows from processes gone for
 * more than a day are pruned in the same tick.
 */
export async function heartbeat(now = new Date()) {
  console.info(`[worker] heartbeat ${now.toISOString()}`);
  await db()
    .insert(workerHeartbeats)
    .values({ processId: PROCESS_ID, lastSeenAt: now })
    .onConflictDoUpdate({
      target: workerHeartbeats.processId,
      set: { lastSeenAt: sql`excluded.last_seen_at` },
    });
  await db()
    .delete(workerHeartbeats)
    .where(
      lt(workerHeartbeats.lastSeenAt, new Date(now.getTime() - PRUNE_AFTER_MS)),
    );
}

registerQueue(Q.heartbeat, () => heartbeat(), { cron: "*/5 * * * *" });
