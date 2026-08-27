import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";

/** One-time tokens for out-of-band callbacks (CloudFormation → Sendsprite). Stored hashed. */
export const setupTokens = pgTable("setup_tokens", {
  id: text("id").primaryKey(), // stok_<ulid>
  purpose: text("purpose", { enum: ["aws_callback"] }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  issuedBy: text("issued_by")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  /**
   * Which team the CloudFormation stack is connecting. Read off the token by
   * the callback, so a stack created for one team can never connect into
   * another even with a valid token. Added nullable in 0021, backfilled by
   * 0022, made NOT NULL in 0023.
   */
  teamId: text("team_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  region: text("region").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  /** Why the callback that consumed this token did not connect (surfaced to the wizard). */
  failedAt: timestamp("failed_at", { withTimezone: true }),
  failedReason: text("failed_reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
