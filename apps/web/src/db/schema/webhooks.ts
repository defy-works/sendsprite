import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";

/** Webhook endpoints (spec §8). `secretEnc` is encrypted at rest. */
export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(), // wh_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secretEnc: text("secret_enc").notNull(),
    events: jsonb("events").$type<string[]>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    disabledReason: text("disabled_reason"),
    failingSince: timestamp("failing_since", { withTimezone: true }),
    // Millisecond precision: the keyset cursor round-trips `createdAt`
    // through a JS Date (ms); see schema/emails.ts.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    // `$onUpdate` fires only via drizzle `.update()`; upserts must set it.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("webhooks_team_idx").on(t.teamId)],
);
