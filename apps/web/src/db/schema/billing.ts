import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { PLANS } from "@sendsprite/shared";
import { organization } from "./auth";

/**
 * One row per team once it has been through checkout: the entitlement
 * snapshot resolved from the provider's product metadata, so rendering the
 * billing page and enforcing caps never needs a provider call. A team with no
 * row is on the free plan.
 *
 * `providerModifiedAt` is the ordering guard: webhooks can arrive out of
 * order, so an update whose payload is older than what is stored is dropped
 * (the same idea as the status ranking in `services/email-events.ts`).
 */
export const teamBilling = pgTable("team_billing", {
  teamId: text("team_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  // Provider-side identifiers. `providerCustomerId` is the provider's own id;
  // the team id itself is the provider's `external_customer_id`.
  provider: text("provider").notNull().default("polar"),
  providerCustomerId: text("provider_customer_id"),
  subscriptionId: text("subscription_id"),
  productId: text("product_id"),
  plan: text("plan", { enum: PLANS }).notNull().default("free"),
  /** Provider status verbatim (`active`, `past_due`, …); null before any subscription. */
  status: text("status"),
  /**
   * Deliberately `notNull()` with **no** DB default: drizzle types a column
   * like this as *required* in `$inferInsert`, so an upsert that forgets the
   * allowance fails to compile. A `DEFAULT 3000` would instead be silently
   * accepted and cap a paying Scale customer at the Free allowance.
   */
  includedEmails: integer("included_emails").notNull(),
  overagePer1kCents: integer("overage_per_1k_cents").notNull().default(0),
  /** The subscription carries a metered price → no hard monthly cap. */
  overageEnabled: boolean("overage_enabled").notNull().default(false),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  // Both period bounds are millisecond precision, matching
  // `billing_events.created_at` and the rule migration 0011 established. They
  // arrive in one provider payload, round-trip through a JS `Date` (ms), and
  // are compared for equality against `billing_usage`'s pair — and the natural
  // period identity is `nextPeriodStart === prevPeriodEnd`, so the end bound
  // needs the same treatment as the start or that comparison misses at the
  // boundary.
  periodStart: timestamp("period_start", {
    withTimezone: true,
    precision: 3,
  }).notNull(),
  periodEnd: timestamp("period_end", {
    withTimezone: true,
    precision: 3,
  }).notNull(),
  /**
   * `modified_at` of the newest provider payload applied; the ordering guard
   * that drops an out-of-order webhook. Millisecond precision because it is
   * compared with `<` against a value that has been through a JS `Date`.
   */
  providerModifiedAt: timestamp("provider_modified_at", {
    withTimezone: true,
    precision: 3,
  }).notNull(),
  /** When the past-due grace clock started; null while not past due. */
  pastDueAt: timestamp("past_due_at", { withTimezone: true }),
  /**
   * `paid_at` of the newest `order.paid` applied — the ordering guard for
   * *clearing* `pastDueAt`. Without it, a late or replayed `order.paid` for an
   * earlier invoice, arriving after the subscription has gone `past_due`
   * again, would reset the grace clock and buy another week of paid caps on a
   * dead card. Task 6 clears `pastDueAt` only when the incoming `paid_at` is
   * newer than this. Millisecond precision for the same reason as
   * `providerModifiedAt`: it is a `<` guard against a JS `Date`.
   */
  lastOrderPaidAt: timestamp("last_order_paid_at", {
    withTimezone: true,
    precision: 3,
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // `$onUpdate` fires only via drizzle `.update()`; upserts must set it.
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
export type TeamBilling = typeof teamBilling.$inferSelect;

/**
 * Metering watermark per team per billing period. `reportedThrough` is the
 * exclusive end of the last hourly bucket successfully ingested; it only ever
 * moves forward, and only after the provider returned 2xx. Nothing here is a
 * cache of the usage count — the count is read live from `emails`, the same
 * source the caps use, so the two can never disagree.
 */
export const billingUsage = pgTable(
  "billing_usage",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Millisecond precision on both bounds: `period_start` is half the primary
    // key and is matched for equality against `team_billing.period_start`, and
    // `period_end` is what the next period's start is derived from. Every side
    // must round-trip through a JS `Date` identically or a lookup silently
    // misses its row.
    periodStart: timestamp("period_start", {
      withTimezone: true,
      precision: 3,
    }).notNull(),
    periodEnd: timestamp("period_end", {
      withTimezone: true,
      precision: 3,
    }).notNull(),
    reportedThrough: timestamp("reported_through", { withTimezone: true }),
    reportedUnits: integer("reported_units").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // `$onUpdate` fires only via drizzle `.update()`; upserts must set it.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.periodStart] })],
);
export type BillingUsage = typeof billingUsage.$inferSelect;

/**
 * Every provider webhook delivery we have seen. The primary key **is** the
 * delivery id from the `webhook-id` header (Standard Webhooks: unique per
 * delivery, reused on retries), so deduplication is an
 * `onConflictDoNothing` — no lookup, no race between two replicas handling
 * the same retry. Never key on the resource id: `order.created` and
 * `order.paid` share one.
 *
 * **The insert and the `appliedAt` / `skippedReason` update belong in one
 * transaction** (Task 6). Run as two statements they open a crash window: die
 * between them and the row exists — so every retry short-circuits as a
 * duplicate — while the event was never applied, silently losing a
 * subscription change. A transaction is atomic and needs no recovery sweep:
 * the provider retries on a non-2xx, so a rolled-back delivery is simply
 * redelivered and its dedupe key is free again.
 *
 * `teamId` deliberately carries **no** foreign key: the row is written before
 * the team is resolved (so an FK would make the endpoint retry a delivery it
 * can never store), and a cascade would erase the very idempotency keys this
 * table exists to hold. `audit.ts` is the house precedent.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: text("id").primaryKey(), // the provider's delivery id (`webhook-id`)
    teamId: text("team_id"), // null when the payload named no team
    type: text("type").notNull(),
    /** Provider resource the event is about (subscription id, order id…). */
    objectId: text("object_id"),
    /** Set once the event has been applied; null means received but skipped. */
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    /**
     * Why it was skipped (stale, unknown team, unmodelled type) — or, with
     * `appliedAt` set, why it applied only in part (a product whose plan
     * metadata is unusable applies its status and withholds its plan fields).
     */
    skippedReason: text("skipped_reason"),
    /**
     * A `{ type }` stub, kept as a debugging aid only. Deliberately **not** a
     * replay record — redelivery is the provider's job — and deliberately
     * **not** the raw request body, which would pull customer PII into a
     * table that has no purge story.
     */
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    // Millisecond precision: this table is shaped so a future admin view can
    // keyset-page it, and the cursor round-trips `createdAt` through a JS
    // Date (ms); see schema/emails.ts.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("billing_events_team_created_idx").on(t.teamId, t.createdAt)],
);
export type BillingEvent = typeof billingEvents.$inferSelect;
