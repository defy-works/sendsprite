import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  CAMPAIGN_STATUSES,
  type CampaignBlock,
  type CampaignCounts,
} from "@sendsprite/shared";
import { contacts } from "./contacts";
import { emails } from "./emails";
import { organization } from "./auth";

/**
 * A fresh campaign's counts. `counts` is a cache rebuilt from
 * `emails`/`email_events` (Decision 8), never an incremented tally, so the
 * stored value starts as the honest all-zero answer rather than `{}` — the
 * REST layer returns it verbatim as `CampaignObject.counts`, which the shared
 * contract types as nine required numbers.
 */
export const ZERO_CAMPAIGN_COUNTS: CampaignCounts = {
  recipients: 0,
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  unsubscribed: 0,
  bounced: 0,
  complained: 0,
  failed: 0,
};

/**
 * One bulk send to a contact book (spec §5, Phase 7).
 *
 * A campaign is a recipient-row generator: it materialises ordinary `emails`
 * rows in resumable chunks and everything downstream — the SES token bucket,
 * suppression, tracking, events, webhooks, metering — runs unchanged.
 *
 * ## Only the team is a foreign key, on purpose
 *
 * `team_id` cascades because a deleted team takes its whole tenancy with it,
 * as it does everywhere else in this schema. `book_id` and `domain_id` do
 * **not** reference their tables at all, and the choice is between three bad
 * options rather than an oversight:
 *
 * - `restrict` would block deleting a contact book or a domain for as long as
 *   any campaign — including one sent two years ago — points at it. Neither
 *   `deleteBook` nor `deleteDomain` catches a foreign-key violation, so the
 *   symptom would not be a helpful "still in use" message but an unhandled
 *   Postgres error surfacing as a 500 on a Phase 6 screen. There is not one
 *   `restrict` anywhere else in this schema.
 * - `cascade` would silently erase the record of a send that really happened
 *   the moment someone tidies up an old audience. Deleting a list is not
 *   asking to forget having mailed it.
 * - `set null` is what `emails.domain_id` and `emails.template_id` do for
 *   exactly this tension, and it is unavailable here: `CampaignObject` types
 *   `bookId` and `domainId` as non-nullable strings, so the columns cannot go
 *   nullable without changing the shared contract.
 *
 * So the ids are plain `text`, and a dangling one reads as "the book is gone",
 * which is the truth. Every reader must therefore left-join and render the
 * missing side rather than assume it: **the campaign list must not crash on a
 * dangling reference.** That a book or domain exists and belongs to the
 * caller's team is checked by the service on create and update, which is where
 * the shared contract already says that question belongs.
 */
export const campaigns = pgTable(
  "campaigns",
  {
    id: text("id").primaryKey(), // cmp_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The contact book the audience is drawn from. No FK; see above. */
    bookId: text("book_id").notNull(),
    /** The verified sending domain `from` belongs to. No FK; see above. */
    domainId: text("domain_id").notNull(),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    from: text("from").notNull(),
    replyTo: text("reply_to"),
    /** The authored block list; the only stored representation of the body. */
    blocks: jsonb("blocks").$type<CampaignBlock[]>().notNull(),
    /**
     * Rendered once when sending starts, then reused for every recipient.
     * Stored so a later edit of `blocks` cannot change what a half-sent
     * campaign puts in the remaining inboxes — the first and last recipient
     * of one campaign must receive the same mail.
     */
    html: text("html"),
    text: text("text"),
    status: text("status", { enum: CAMPAIGN_STATUSES })
      .notNull()
      .default("draft"),
    scheduledAt: timestamp("scheduled_at", {
      withTimezone: true,
      precision: 3,
    }),
    startedAt: timestamp("started_at", { withTimezone: true, precision: 3 }),
    sentAt: timestamp("sent_at", { withTimezone: true, precision: 3 }),
    /**
     * Keyset cursor into the book, so each sweep tick resumes in O(chunk)
     * rather than re-scanning what it already materialised. It is an
     * optimisation, not the correctness mechanism — the primary key on
     * `campaign_recipients` is what actually prevents a double send.
     */
    fanoutCursor: text("fanout_cursor"),
    /** Cache, not a tally. Rebuilt from `emails`/`email_events` (Decision 8). */
    counts: jsonb("counts")
      .$type<CampaignCounts>()
      .notNull()
      .default(ZERO_CAMPAIGN_COUNTS),
    createdBy: text("created_by"),
    // Millisecond precision on every timestamp here: the list is keyset-paged
    // on `createdAt`, and `scheduledAt`/`startedAt`/`sentAt` are all compared
    // against values that have been through a JS `Date` (ms). Migration 0011
    // exists because a µs/ms mismatch silently skipped rows; see
    // schema/emails.ts.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    // `$onUpdate` fires only via drizzle `.update()`; upserts must set it.
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("campaigns_team_created_idx").on(t.teamId, t.createdAt, t.id),
    // The sweep's only query: campaigns that still owe work.
    index("campaigns_status_idx").on(t.status, t.scheduledAt),
  ],
);
export type Campaign = typeof campaigns.$inferSelect;

export const CAMPAIGN_RECIPIENT_STATUSES = [
  "pending",
  "queued",
  "skipped",
] as const;
export type CampaignRecipientStatus =
  (typeof CAMPAIGN_RECIPIENT_STATUSES)[number];

/**
 * One contact's place in one campaign's fan-out — the bookkeeping that makes
 * the fan-out resumable, and the guard that makes it safe to retry.
 *
 * `(campaign_id, contact_id)` is the identity, so there is no surrogate id,
 * the way `template_versions` is keyed on `(template_id, version)`. The unique
 * index Postgres builds for that primary key **is the double-send guard**:
 * everything else about the fan-out — the cursor, the chunk size, the sweep
 * cadence — is an optimisation, but this constraint is the correctness
 * boundary. It is what turns a retried or overlapping chunk into a no-op
 * instead of a second copy in someone's inbox, so materialisation inserts with
 * `ON CONFLICT DO NOTHING` against it and trusts the row count.
 *
 * Both references cascade: these rows are working state, not history. The
 * history of a send lives in `emails`, whose `campaign_id`/`contact_id` are
 * deliberately FK-free and outlive both sides.
 */
export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /**
     * The materialised `emails` row, once there is one. `set null` rather than
     * cascade: retention never deletes an `emails` row, but if one ever goes,
     * losing the recipient row with it would reopen the double-send window.
     */
    emailId: text("email_id").references(() => emails.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: CAMPAIGN_RECIPIENT_STATUSES })
      .notNull()
      .default("pending"),
    /** Why a recipient was skipped: `suppressed`, `unsubscribed`, `invalid`. */
    skipReason: text("skip_reason"),
    // Millisecond precision, as everywhere else; see schema/emails.ts.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.campaignId, t.contactId] }),
    index("campaign_recipients_email_idx").on(t.emailId),
  ],
);
export type CampaignRecipient = typeof campaignRecipients.$inferSelect;
