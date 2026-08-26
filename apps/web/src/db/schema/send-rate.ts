import { doublePrecision, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./auth";

/**
 * Token bucket for one team's SES `MaxSendRate`. It was a singleton
 * (`send_rate_state`) while the whole instance shared one AWS account; per
 * tenant it must be per team, and that also removes a real coupling — one
 * team's volume could drain the bucket every other team drew from.
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
