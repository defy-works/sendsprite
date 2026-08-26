import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { EMAIL_EVENT_TYPES } from "@sendsprite/shared";
import { emails } from "./emails";

export type { EmailEventType } from "@sendsprite/shared";
/** Per-email timeline. `dedupeKey` makes SNS redelivery idempotent. */
export const emailEvents = pgTable(
  "email_events",
  {
    id: text("id").primaryKey(), // evt_<ulid>
    emailId: text("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    type: text("type", { enum: EMAIL_EVENT_TYPES }).notNull(),
    dedupeKey: text("dedupe_key").notNull(), // e.g. "sns:<MessageId>" or "local:<ulid>"
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("email_events_dedupe_uidx").on(t.emailId, t.dedupeKey),
    index("email_events_email_idx").on(t.emailId, t.occurredAt),
    index("email_events_team_type_idx").on(t.teamId, t.type, t.occurredAt),
  ],
);
