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
  includedEmails: integer("included_emails").notNull(),
  overagePer1kCents: integer("overage_per_1k_cents").notNull().default(0),
  /** The subscription carries a metered price → no hard monthly cap. */
  overageEnabled: boolean("overage_enabled").notNull().default(false),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  /** `modified_at` of the newest provider payload applied; ordering guard. */
  providerModifiedAt: timestamp("provider_modified_at", {
    withTimezone: true,
  }).notNull(),
  pastDueAt: timestamp("past_due_at", { withTimezone: true }),
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
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
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
    /** Why it was skipped (stale, unknown team, unmodelled type). */
    skippedReason: text("skipped_reason"),
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
