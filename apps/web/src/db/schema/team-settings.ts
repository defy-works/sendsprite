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
  /**
   * This team's own retention window. Null means "use the instance
   * maximum". Always clamped by `instance_settings.retention_days`, which is
   * a ceiling — a team may shorten its window, never extend it.
   */
  retentionDays: integer("retention_days"),
  /** Set when this team finishes the connect wizard; gates /app. */
  setupCompleted: boolean("setup_completed").notNull().default(false),
  /**
   * Set by an instance admin to stop this team sending, and by nobody else —
   * there is no team-facing control for it.
   *
   * A timestamp rather than a boolean, because "when" is the first thing
   * asked about a suspension and a boolean cannot answer it. The reason is
   * shown to the team verbatim: a team that cannot send and is not told why
   * files a support ticket, which is the outcome suspending them was supposed
   * to avoid.
   *
   * Enforced in `checkTeamCaps`, so it covers the REST API, SMTP, campaign
   * fan-out and the dashboard at once — every send path runs the caps.
   */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedReason: text("suspended_reason"),
  trackOpens: boolean("track_opens").notNull().default(true),
  trackClicks: boolean("track_clicks").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // `$onUpdate` fires only via drizzle `.update()`; upserts
  // (`onConflictDoUpdate`) must set `updatedAt` explicitly.
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
