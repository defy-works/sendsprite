import { z } from "zod";

/** Plan ladder, cheapest first. Matches `metadata.plan` on the Polar products. */
export const PLANS = ["free", "pro", "scale"] as const;
export type Plan = (typeof PLANS)[number];

/**
 * What an operator may grant, or name in `DEFAULT_PLAN`. `unlimited` is not a
 * product: it has no catalog entry and means "no monthly cap".
 */
export const GRANTABLE_PLANS = [...PLANS, "unlimited"] as const;
export type GrantedPlan = (typeof GRANTABLE_PLANS)[number];

/**
 * Narrows a plan name that arrived as a `string` — from a form, or from the
 * `text` column a grant is stored in. Both of those are claims, and neither
 * the database nor a POST body is checked by the type system.
 */
export const isGrantedPlan = (v: string): v is GrantedPlan =>
  (GRANTABLE_PLANS as readonly string[]).includes(v);

/** Where a team's entitlement came from. */
export const ENTITLEMENT_SOURCES = [
  "subscription",
  "override",
  "default",
] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

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

/**
 * Provider metadata values are `string | number | boolean`, and a value typed
 * by hand in the dashboard arrives as a string — so a numeric string has to be
 * accepted. It is accepted *narrowly*, by preprocess and not by
 * `z.coerce.number()`: coercion is `Number(v)`, and `Number(null)`,
 * `Number("")`, `Number(false)` and `Number([])` are all `0`, while
 * `Number("0x10")` is 16 and `Number("1e5")` is 100 000. Coercing would turn a
 * cleared `included_emails` field into a *valid* plan of zero included emails,
 * which reads as a real entitlement everywhere downstream and 429s every send
 * a paying customer makes. Anything that is not a number or an all-digits
 * string is rejected, so malformed is indistinguishable from absent.
 */
const int = z.preprocess(
  (v) => (typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v),
  z.number().int().min(0),
);

const RawPlanMetadata = z.object({
  plan: z.enum(PLANS),
  included_emails: int,
  // Display only — whether overage is billed at all is decided by the
  // subscription's metered price, not by this number — so a typo degrades to
  // 0 rather than failing the object and un-planning a paying customer.
  overage_per_1k_cents: int.catch(0),
});

/**
 * Provider product metadata → `PlanMetadata`, or `null` when the product is
 * not one of ours **or** is one of ours with unusable fields. Never throws: it
 * runs inside webhook handling, where a bad product must degrade rather than
 * 500.
 *
 * `null` alone cannot tell those two cases apart; use `claimsPlanMetadata` when
 * the difference matters.
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
 * Whether the metadata claims to be one of our plan products at all, however
 * broken the rest of it is. This is the difference between "a product we do
 * not sell" and "our Pro product whose `included_emails` someone just cleared
 * in the dashboard": the first is genuinely not a plan, the second is a
 * configuration fault. A caller applying a subscription uses it to refuse the
 * change — keeping the entitlement already stored and warning — instead of
 * overwriting a paid entitlement on the strength of a bad string.
 */
export const claimsPlanMetadata = (metadata: unknown): boolean =>
  z.object({ plan: z.enum(PLANS) }).safeParse(metadata).success;

/**
 * Subscription lifecycle states we model.
 *
 * **Documentation only.** Nothing validates against this list: the stored
 * column is plain `text` and `BillingStateObject.status` is `z.string()`, on
 * purpose — a provider status we have not modelled must round-trip verbatim
 * and be treated as not entitling, never be rejected at the database boundary
 * where it would fail the webhook and leave the row stale. Do not "fix" the
 * column to use this as an enum.
 *
 * Diffed against `SubscriptionStatus` in `@polar-sh/sdk@0.49.0` and found
 * identical, `paused` included — Polar really does model a paused
 * subscription (`pause_at_period_end`, `paused_at`, `resumes_at` all exist on
 * its subscription payload). The SDK's enum is itself open, so an unlisted
 * status still round-trips. `apps/web/tests/unit/billing-polar.test.ts` pins
 * the two together, because this package must stay free of a provider
 * dependency and so cannot check it itself.
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
 * a card expires is a worse failure than carrying them. How *long* they are
 * carried is not decided here — this is a pure function of the status — and
 * any time-boxing of the past-due window belongs to entitlement resolution,
 * which is the only caller that knows when the subscription went past due.
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
  plan: z.enum(GRANTABLE_PLANS),
  status: z.string().nullable(),
  /** Null on an unlimited grant. */
  includedEmails: z.number().int().nullable(),
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
  /** `override`: an operator grant; `default`: `DEFAULT_PLAN`; else the subscription. */
  source: z.enum(ENTITLEMENT_SOURCES),
  /**
   * When the subscription went past due, `null` otherwise. Reserved for the
   * banner and for time-boxing the past-due window; no code consumes it yet,
   * and it arrives with entitlement resolution.
   */
  pastDueAt: z.string().nullable(),
});
export type BillingStateObject = z.infer<typeof BillingStateObject>;
