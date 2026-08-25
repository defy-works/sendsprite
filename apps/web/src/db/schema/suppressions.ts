import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { SUPPRESSION_REASONS } from "@sendsprite/shared";
import { organization } from "./auth";

export type { SuppressionReason } from "@sendsprite/shared";
/** Per-team suppression list (spec §5); `email` is stored normalised. */
export const suppressions = pgTable(
  "suppressions",
  {
    id: text("id").primaryKey(), // sup_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(), // normalised
    reason: text("reason", { enum: SUPPRESSION_REASONS }).notNull(),
    sourceEmailId: text("source_email_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("suppressions_team_email_uidx").on(t.teamId, t.email)],
);
