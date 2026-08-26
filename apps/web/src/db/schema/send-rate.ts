import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";

/**
 * Token bucket for one team's SES `MaxSendRate`. It was a singleton while
 * the whole instance shared one AWS account; per tenant it must be per team,
 * and that also removes a real coupling — one team's volume could drain the
 * bucket every other team drew from.
 */
export const teamSendRate = pgTable("team_send_rate", {
  teamId: text("team_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  tokens: doublePrecision("tokens").notNull().default(0),
  refilledAt: timestamp("refilled_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * @deprecated Superseded by `teamSendRate`. Kept in the schema only so the
 * additive migration that creates `team_send_rate` does not also drop this
 * one: drizzle-kit reads a table dropped and a table created in the same
 * diff as a possible rename and stops to ask, which needs a TTY it does not
 * have here. The drop is migration 0023, on its own, where it is
 * unambiguous. Nothing reads this table any more.
 */
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
