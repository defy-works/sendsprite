import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
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
    // Millisecond precision: the keyset cursor round-trips `createdAt`
    // through a JS Date (ms); see schema/emails.ts.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("suppressions_team_email_uidx").on(t.teamId, t.email),
    /*
     * Campaign audience selection joins this table to `contacts` and must do
     * it case-insensitively, so this is the index that join reads.
     *
     * `contacts.email` carries a check constraint (`email = lower(btrim(
     * email))`) and this column does **not** — every writer here normalises
     * (`suppressFromEvent` via `normaliseEmail`, the API via
     * `AddSuppressionInput`), but that is a property of the code, not of the
     * table, and the unique index above compares raw bytes, so `A@b.io` and
     * `a@b.io` are two rows to Postgres. A plain `contacts.email =
     * suppressions.email` join would therefore mail a suppressed address the
     * moment one row got in with an uppercase letter — a seed, a backfill, a
     * restored dump, or a future writer that forgets. See
     * `services/campaigns/audience.ts`.
     *
     * It is an expression index rather than a check constraint because a
     * constraint cannot be added to an existing self-hosted install that
     * already holds a mixed-case row: the migration would fail on boot. The
     * join is written to tolerate the bad data instead of refusing to start.
     */
    index("suppressions_team_lower_email_idx").on(
      t.teamId,
      sql`lower(btrim(${t.email}))`,
    ),
  ],
);
