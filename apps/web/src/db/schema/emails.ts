import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { EMAIL_STATUS } from "@sendsprite/shared";
import { organization } from "./auth";
import { domains } from "./domains";

/** Single source of truth is the shared API contract; alias kept for schema-side imports. */
export const EMAIL_STATUSES = EMAIL_STATUS;
export type { EmailStatus } from "@sendsprite/shared";

export const EMAIL_SOURCES = ["api", "smtp", "campaign", "dashboard"] as const;
export type EmailSource = (typeof EMAIL_SOURCES)[number];

export interface AttachmentMeta {
  id: string; // att_<ulid>
  filename: string;
  contentType: string;
  size: number;
}

/** One outbound message (spec §5). Bodies are purged by retention; metadata stays. */
export const emails = pgTable(
  "emails",
  {
    id: text("id").primaryKey(), // em_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    apiKeyId: text("api_key_id"),
    // Nullable: the mail log must never block deleting a domain.
    domainId: text("domain_id").references(() => domains.id, {
      onDelete: "set null",
    }),
    from: text("from").notNull(), // "Name <a@b>" as given
    fromEmail: text("from_email").notNull(), // normalised address
    to: jsonb("to").$type<string[]>().notNull(),
    cc: jsonb("cc").$type<string[]>().notNull().default([]),
    bcc: jsonb("bcc").$type<string[]>().notNull().default([]),
    replyTo: jsonb("reply_to").$type<string[]>().notNull().default([]),
    subject: text("subject").notNull(),
    html: text("html"),
    text: text("text"),
    headers: jsonb("headers")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    tags: jsonb("tags").$type<Record<string, string>>().notNull().default({}),
    attachmentsMeta: jsonb("attachments_meta")
      .$type<AttachmentMeta[]>()
      .notNull()
      .default([]),
    // Resolved at create time from team defaults + per-request override.
    trackOpens: boolean("track_opens").notNull().default(true),
    trackClicks: boolean("track_clicks").notNull().default(true),
    status: text("status", { enum: EMAIL_STATUSES })
      .notNull()
      .default("queued"),
    source: text("source", { enum: EMAIL_SOURCES }).notNull().default("api"),
    idempotencyKey: text("idempotency_key"),
    sesMessageId: text("ses_message_id"),
    lastError: text("last_error"),
    attempts: integer("attempts").notNull().default(0),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    bodyPurgedAt: timestamp("body_purged_at", { withTimezone: true }),
    // Millisecond precision on purpose: the list cursor round-trips
    // `createdAt` through a JS Date (ms), so a microsecond column would
    // make the keyset comparison skip rows created within the same
    // millisecond.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    // `$onUpdate` fires only via drizzle `.update()`; upserts must set it.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Postgres unique indexes allow multiple NULLs, so rows without an
    // idempotency key / SES message id never collide.
    uniqueIndex("emails_team_idempotency_uidx").on(t.teamId, t.idempotencyKey),
    uniqueIndex("emails_ses_message_uidx").on(t.sesMessageId),
    index("emails_team_created_idx").on(t.teamId, t.createdAt),
    index("emails_team_status_idx").on(t.teamId, t.status),
    index("emails_purge_idx").on(t.bodyPurgedAt, t.createdAt),
    // Overview stats scan `sent_at` windows per team and instance-wide.
    index("emails_sent_at_idx").on(t.teamId, t.sentAt),
    index("emails_sent_at_all_idx").on(t.sentAt),
  ],
);
