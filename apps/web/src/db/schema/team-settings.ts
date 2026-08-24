import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";

/**
 * Per-team knobs the spec puts on `teams` (§5). Kept 1:1 with better-auth's
 * `organization` so `schema/auth.ts` stays purely generated.
 * Convention (all Sendsprite tables): timestamps are `withTimezone: true`.
 */
export const teamSettings = pgTable("team_settings", {
  teamId: text("team_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  dailyLimit: integer("daily_limit"),
  monthlyLimit: integer("monthly_limit"),
  trackOpens: boolean("track_opens").notNull().default(true),
  trackClicks: boolean("track_clicks").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
