import { z } from "zod";

/** Plan ladder, cheapest first. Matches `metadata.plan` on the Polar products. */
export const PLANS = ["free", "pro", "scale"] as const;
export type Plan = (typeof PLANS)[number];

/**
 * The contract each billing product carries in its provider-side metadata.
 * Product **ids are never hardcoded**: the app finds a product by listing the
 * catalog and matching `plan`, and maps a subscription to entitlements by
 * reading these three fields off the product the subscription points at. So
 * prices, ids and even the number of tiers can change without a deploy.
 *
 * The per-plan spend ceiling on overage is deliberately *not* here: it lives on
 * the provider's metered price (`cap_amount` in Polar), which is where the
 * provider itself enforces it. Nothing in this app has to know it to bill.
 */
export const PlanMetadata = z.object({
  plan: z.enum(PLANS),
  /** Emails included in the fixed monthly price. */
  includedEmails: z.number().int().min(0),
  /** Cents per 1 000 emails beyond `includedEmails`. 0 on a hard-capped plan. */
  overagePer1kCents: z.number().int().min(0),
});
export type PlanMetadata = z.infer<typeof PlanMetadata>;

/** What a team with no subscription at all gets. */
export const FREE_PLAN_METADATA: PlanMetadata = {
  plan: "free",
  includedEmails: 3000,
  overagePer1kCents: 0,
};

// Provider metadata values are `string | number | boolean`; Polar preserves the
// JSON type it was given, but a value typed by hand in the dashboard arrives as
// a string. Coerce rather than reject: a mistyped number must not un-plan a
// paying customer.
const int = z.coerce.number().int().min(0);
const RawPlanMetadata = z.object({
  plan: z.enum(PLANS),
  included_emails: int,
  overage_per_1k_cents: int.default(0),
});

/**
 * Provider product metadata → `PlanMetadata`, or `null` when the product is
 * not one of ours (or is missing the fields). Never throws: it runs inside
 * webhook handling, where a bad product must degrade to "free", not 500.
 */
export function planFromProductMetadata(
  metadata: unknown,
): PlanMetadata | null {
  const parsed = RawPlanMetadata.safeParse(metadata);
  if (!parsed.success) return null;
  return {
    plan: parsed.data.plan,
    includedEmails: parsed.data.included_emails,
    overagePer1kCents: parsed.data.overage_per_1k_cents,
  };
}

/**
 * Subscription lifecycle states we model. The list is Polar's, but the names
 * are generic enough to survive a provider swap; anything not in it is stored
 * verbatim and treated as not entitling.
 */
export const SUBSCRIPTION_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * Statuses that keep the paid entitlement. `past_due` deliberately does:
 * dunning is the provider's job and cutting a customer's sending off the hour
 * a card expires is a worse failure than carrying them for a cycle. It is not
 * open-ended — entitlement resolution carries a past-due team for a grace
 * window measured from `pastDueAt` and then falls back to the free caps — but
 * that clock lives with the entitlement, not with the status. The dashboard
 * shows a banner throughout (see the Billing page).
 */
const ENTITLED: ReadonlySet<string> = new Set([
  "trialing",
  "active",
  "past_due",
]);
export const isEntitledStatus = (status: string | null | undefined): boolean =>
  status != null && ENTITLED.has(status);

/** What the dashboard renders. `managed: false` = never went through checkout. */
export const BillingStateObject = z.object({
  enabled: z.boolean(),
  plan: z.enum(PLANS),
  status: z.string().nullable(),
  includedEmails: z.number().int(),
  overagePer1kCents: z.number().int(),
  /** The subscription carries a metered price, so sends past the include are billed. */
  overageEnabled: z.boolean(),
  cancelAtPeriodEnd: z.boolean(),
  periodStart: z.string(),
  periodEnd: z.string(),
  /** Emails created in this period that count (same rule as the send caps). */
  used: z.number().int(),
  /** Units already ingested to the provider this period. */
  reportedUnits: z.number().int(),
  /** There is a provider subscription behind this state. */
  managed: z.boolean(),
  /**
   * When the subscription went `past_due`; the grace window runs from here.
   * Absent for every state that is not past due, which is the common case.
   */
  pastDueAt: z.string().nullable().optional(),
});
export type BillingStateObject = z.infer<typeof BillingStateObject>;
