import type { Plan, PlanMetadata } from "@sendsprite/shared";

/** A purchasable plan in the provider's catalog, resolved from its metadata. */
export interface PlanProduct extends PlanMetadata {
  productId: string;
  name: string;
  /** Fixed recurring price in cents. */
  priceCents: number;
  /** The product carries a metered price, so overage can be billed. */
  hasMeteredPrice: boolean;
}

/** A subscription, normalised. `plan` is null when the product is not ours. */
export interface ProviderSubscription {
  subscriptionId: string;
  customerId: string;
  /** Our team id, set as the provider's external customer id at checkout. */
  externalCustomerId: string | null;
  productId: string;
  /** Provider status verbatim; `isEntitledStatus` decides what it means. */
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** Newest of the payload's modified/created stamps; the ordering guard. */
  modifiedAt: Date;
  hasMeteredPrice: boolean;
  /**
   * Ceiling the provider puts on metered charges per cycle, in cents
   * (`cap_amount` on the Polar price), or `null` when the metered price is
   * uncapped, absent, or the provider has no such concept. **Display only.**
   * It is provider configuration, not a plan attribute — which is why it is
   * not in `PlanMetadata` — and nothing in this app enforces it; it is
   * surfaced only so the billing page can honestly say "overage is capped at
   * $200 a cycle" when it knows so.
   *
   * Required rather than optional: every implementation can answer "is there a
   * ceiling", even if the answer is always `null`. Two states, not three, so a
   * renderer has no unreachable case to write.
   */
  overageCapCents: number | null;
  plan: PlanMetadata | null;
  /**
   * The product declares one of our plans, however unusable the rest of its
   * metadata is (`claimsPlanMetadata` in `@sendsprite/shared`). With
   * `plan === null` this is the whole difference between "a product we do not
   * sell" — free is the right answer — and "our Pro product whose
   * `included_emails` someone just cleared in the dashboard", where writing
   * Free over a paid entitlement on the strength of a bad string is the wrong
   * answer. A caller that cannot resolve a plan must branch on this.
   */
  claimsPlan: boolean;
}

/**
 * A verified webhook, normalised. `deliveryId` is the provider's per-delivery
 * id (reused on retries) and is the only thing safe to deduplicate on — a
 * resource id is shared by several event types about the same object.
 */
export type ProviderEvent =
  | {
      kind: "subscription";
      deliveryId: string;
      type: string;
      subscription: ProviderSubscription;
    }
  | {
      kind: "order_paid";
      deliveryId: string;
      type: string;
      subscriptionId: string | null;
      externalCustomerId: string | null;
      paidAt: Date;
    }
  | { kind: "ignored"; deliveryId: string; type: string };

/** One rolled-up usage record. `externalId` makes redelivery a no-op. */
export interface UsageEvent {
  /** Deterministic per (team, bucket) so a retry cannot double-count. */
  externalId: string;
  externalCustomerId: string;
  name: string;
  count: number;
  timestamp: Date;
}

export type VerifyResult =
  { ok: true; event: ProviderEvent } | { ok: false; reason: string };

/** Thrown when billing is on but the provider cannot be reached or built. */
export class BillingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingUnavailableError";
  }
}

/**
 * Everything the app needs from a payment provider. Nothing here names Polar:
 * a second implementation (or a move into a private package) is a new file,
 * not a redesign. Implementations may throw; callers wrap.
 */
export interface BillingProvider {
  /** `"polar"`, `"fake"` — stored on `team_billing.provider`. */
  readonly id: string;
  /**
   * Optional: pre-load anything `verifyWebhook` needs. Awaited once by the
   * factory, because `verifyWebhook` is synchronous and an implementation that
   * loads its SDK lazily cannot do it on the first delivery.
   */
  ready?(): Promise<void>;
  /** Catalog products carrying our plan metadata, cheapest first. */
  listPlanProducts(): Promise<PlanProduct[]>;
  createCheckout(input: {
    productId: string;
    externalCustomerId: string;
    customerEmail?: string;
    successUrl: string;
    /** Copied onto the resulting subscription; carries the team id as a fallback. */
    metadata?: Record<string, string>;
  }): Promise<{ url: string }>;
  createPortalSession(input: {
    externalCustomerId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  /** Signature check + normalisation. Never throws; returns a reason instead. */
  verifyWebhook(body: string, headers: Headers): VerifyResult;
  ingestUsage(
    events: UsageEvent[],
  ): Promise<{ inserted: number; duplicates: number }>;
  /**
   * The provider's own metered balance for a customer — **credited minus
   * consumed**, so it counts *down* towards zero and can go negative once the
   * cycle's included units are used up. Display only, and **never throws**:
   * `null` means "cannot be read" (no meter configured, no such customer, or
   * the provider is having a bad day), because a reconciliation figure must
   * not be able to break the page it decorates.
   */
  meterBalance?(externalCustomerId: string): Promise<number | null>;
}

/**
 * Event types that carry a subscription, and so are dispatched to the
 * `subscription` branch of `ProviderEvent`. The seam owns this vocabulary
 * rather than any one implementation, because the fake and the real provider
 * must agree: a test that invents `subscription.foo` has to fail the same way
 * against both, or it proves nothing about production.
 *
 * Note this is the **dispatch** set, not the refusal set. Deciding whether an
 * unparseable delivery may be dropped keys off the `subscription.` prefix, so
 * that a subscription type Polar ships after this list was written is still
 * refused loudly rather than silently ignored (plan amendment J).
 */
export const SUBSCRIPTION_TYPES: ReadonlySet<string> = new Set([
  "subscription.created",
  "subscription.updated",
  "subscription.active",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.revoked",
  "subscription.past_due",
]);

/** Whether a type is subscription-shaped, modelled or not. */
export const isSubscriptionType = (type: string): boolean =>
  type.startsWith("subscription.");

/**
 * How far a delivery's `webhook-timestamp` may be from now, in seconds, before
 * it is refused as a replay. This is the Standard Webhooks tolerance, which is
 * what `standardwebhooks` enforces inside Polar's own `validateEvent` — it
 * lives on the seam so the fake can enforce the same window rather than
 * accepting deliveries the real provider would reject.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Whether a normalised subscription is usable, and why not if it is not.
 *
 * Every implementation has to answer this, and they must answer it the same
 * way. Polar gets it for free — its SDK refuses to parse a payload missing
 * these fields — so without a shared check the fake would happily hand back a
 * subscription with `subscriptionId: undefined` and three `Invalid Date`s for
 * a delivery the real provider refuses outright. Everything downstream (the
 * ordering guard, the period columns, the entitlement) reads exactly these
 * fields, so an unusable subscription must never reach it.
 */
export function subscriptionDefect(sub: ProviderSubscription): string | null {
  for (const [field, value] of [
    ["subscriptionId", sub.subscriptionId],
    ["productId", sub.productId],
    ["status", sub.status],
  ] as const)
    if (typeof value !== "string" || value === "") return `missing ${field}`;
  for (const [field, value] of [
    ["currentPeriodStart", sub.currentPeriodStart],
    ["currentPeriodEnd", sub.currentPeriodEnd],
    ["modifiedAt", sub.modifiedAt],
  ] as const)
    if (!(value instanceof Date) || Number.isNaN(value.getTime()))
      return `invalid ${field}`;
  return null;
}

/** Catalog order for the upgrade UI. */
export const PLAN_ORDER: Record<Plan, number> = { free: 0, pro: 1, scale: 2 };
