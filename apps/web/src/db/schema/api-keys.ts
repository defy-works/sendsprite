import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { domains } from "./domains";

/** API keys (spec §5). The full key is shown once; only its hash is stored. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(), // key_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(), // "ss_live_ab12cd34" (first 8 chars after prefix), shown in UI
    keyHash: text("key_hash").notNull(), // sha256 hex of the full key
    permission: text("permission", { enum: ["full", "sending_only"] })
      .notNull()
      .default("full"),
    domainId: text("domain_id").references(() => domains.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Millisecond precision: the keyset cursor round-trips `createdAt`
    // through a JS Date (ms); see schema/emails.ts.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("api_keys_hash_uidx").on(t.keyHash),
    index("api_keys_team_idx").on(t.teamId),
  ],
);
