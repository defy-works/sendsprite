import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

/** One-time tokens for out-of-band callbacks (CloudFormation → Sendsprite). Stored hashed. */
export const setupTokens = pgTable("setup_tokens", {
  id: text("id").primaryKey(), // stok_<ulid>
  purpose: text("purpose", { enum: ["aws_callback"] }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  issuedBy: text("issued_by")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
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
