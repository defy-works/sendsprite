import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Persisted worker heartbeats so web-container health can see a separate worker. */
export const workerHeartbeats = pgTable("worker_heartbeats", {
  processId: text("process_id").primaryKey(), // hostname:pid
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
