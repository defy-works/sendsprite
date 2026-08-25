import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  integer,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";

/** Singleton token bucket for the SES account-wide MaxSendRate (row id = 1). */
export const sendRateState = pgTable(
  "send_rate_state",
  {
    id: integer("id").primaryKey().default(1),
    tokens: doublePrecision("tokens").notNull().default(0),
    refilledAt: timestamp("refilled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  () => [check("send_rate_state_singleton", sql`id = 1`)],
);
