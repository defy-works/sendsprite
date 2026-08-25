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
  /** The provider's own meter balance, when it can be read. Display only. */
  meterBalance?(externalCustomerId: string): Promise<number | null>;
}

/** Catalog order for the upgrade UI. */
export const PLAN_ORDER: Record<Plan, number> = { free: 0, pro: 1, scale: 2 };
