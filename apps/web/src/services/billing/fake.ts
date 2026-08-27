import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  claimsPlanMetadata,
  planFromProductMetadata,
} from "@sendsprite/shared";
import {
  isSubscriptionType,
  subscriptionDefect,
  SUBSCRIPTION_TYPES,
  WEBHOOK_TOLERANCE_SECONDS,
  type BillingProvider,
  type PlanProduct,
  type ProviderSubscription,
  type UsageEvent,
  type VerifyResult,
} from "./provider";

/**
 * In-memory stand-in for the payment provider: no network, no credentials, no
 * clock skew. It backs `BILLING_PROVIDER=fake` (refused in production by
 * `env.schema.ts`), every billing unit and integration test, and the
 * Playwright suite — the same role `lib/aws/fake-client.ts` plays for SES.
 *
 * It is deliberately more than a stub. It signs its own webhooks the way a
 * Standard Webhooks provider does, so the verification path is genuinely
 * exercised rather than bypassed; it deduplicates ingested usage on
 * `externalId`, so the exactly-once property of the rollup can be asserted
 * instead of assumed; and `failNext` turns any single call into an outage, so
 * callers can be tested for what they do when the provider is down.
 *
 * The signing secret is a module constant, not per-instance state: a test
 * signs a delivery with one instance and the route under test verifies it
 * with the instance it built for itself.
 */
const SECRET = "fake-billing-secret";

/** Mirrors the sandbox catalog so tests exercise the real metadata shape. */
const CATALOG: PlanProduct[] = [
  {
    productId: "prod_free",
    name: "Sendsprite Free",
    plan: "free",
    priceCents: 0,
    includedEmails: 3000,
    overagePer1kCents: 0,
    hasMeteredPrice: false,
  },
  {
    productId: "prod_pro",
    name: "Sendsprite Pro",
    plan: "pro",
    priceCents: 1200,
    includedEmails: 50000,
    overagePer1kCents: 40,
    hasMeteredPrice: true,
  },
  {
    productId: "prod_scale",
    name: "Sendsprite Scale",
    plan: "scale",
    priceCents: 4900,
    includedEmails: 300000,
    overagePer1kCents: 25,
    hasMeteredPrice: true,
  },
];

/**
 * Raw provider-side metadata per product, in the snake_case shape the real
 * dashboard stores, so the fake resolves plans through exactly the same
 * parser the Polar provider will.
 *
 * Two products exist only to be subscribed to, never listed: `prod_bespoke`
 * carries no plan metadata at all (an operator's one-off product), and
 * `prod_broken` claims to be Pro with an unusable `included_emails` (a
 * dashboard fat-finger). They are the two failure shapes a caller has to tell
 * apart — see `ProviderSubscription.claimsPlan`.
 */
const PRODUCT_METADATA: Record<string, Record<string, unknown>> = {
  prod_free: { plan: "free", included_emails: 3000, overage_per_1k_cents: 0 },
  prod_pro: { plan: "pro", included_emails: 50000, overage_per_1k_cents: 40 },
  prod_scale: {
    plan: "scale",
    included_emails: 300000,
    overage_per_1k_cents: 25,
  },
  prod_bespoke: { note: "not one of ours" },
  prod_broken: { plan: "pro", included_emails: "", overage_per_1k_cents: 40 },
};

/**
 * Per-cycle overage ceilings, mirroring the `cap_amount` the sandbox carries
 * on each metered price. It lives on the price rather than in the metadata
 * above because that is where the real provider keeps it — and, like the real
 * one, nothing here enforces it; it is reported so the dashboard can state it.
 */
const PRODUCT_CAP_CENTS: Record<string, number | null> = {
  prod_pro: 20000,
  prod_scale: 50000,
};

/**
 * Standard Webhooks signs `<id>.<timestamp>.<body>`, not the body alone —
 * that is what stops a captured signature being replayed under a different
 * delivery id. The fake binds the same three, so a test that tampers with any
 * of them fails here exactly as it would against the real provider.
 */
const sign = (deliveryId: string, timestamp: string, body: string) =>
  createHmac("sha256", SECRET)
    .update(`${deliveryId}.${timestamp}.${body}`)
    .digest("hex");

export interface SignedEvent {
  body: string;
  headers: Headers;
  deliveryId: string;
}

export interface FakeSubscriptionInput {
  subscriptionId: string;
  externalCustomerId: string | null;
  productId: string;
  status: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
  modifiedAt?: Date;
  /** Force the metered flag independently of the catalog (overage-off tests). */
  hasMeteredPrice?: boolean;
  /** When the provider put the subscription past due. Omit for none. */
  pastDueAt?: Date;
  /**
   * Force the per-cycle overage ceiling. Omit for the product's own cap; pass
   * `null` for an explicitly uncapped metered price. A subscription with no
   * metered price reports `null` whatever this says.
   */
  overageCapCents?: number | null;
  deliveryId?: string;
}

export interface FakeProvider extends BillingProvider {
  /** Units ingested per external customer, summed — i.e. units *consumed*. */
  readonly ingested: Map<string, number>;
  /** Every `externalId` seen, in order. */
  readonly ingestedIds: string[];
  /** Whether `ready()` has been awaited. Asserts the factory warms it. */
  readonly readied: boolean;
  /** Build a signed payload the way the real provider would. */
  signSubscriptionEvent(type: string, sub: FakeSubscriptionInput): SignedEvent;
  signOrderPaidEvent(input: {
    subscriptionId: string | null;
    externalCustomerId: string | null;
    /**
     * When the order was paid; defaults to now. A *past* value is what stages
     * the replay the past-due grace guard has to refuse — without it that
     * branch can only be reached by hand-building a verified event.
     */
    paidAt?: Date;
    deliveryId?: string;
  }): SignedEvent;
  /** Sign an arbitrary body — for malformed-payload and unknown-type tests. */
  signRaw(body: string, deliveryId?: string): SignedEvent;
  /**
   * Grant metered credits to a customer, the way a plan's benefit does at the
   * start of a cycle. `meterBalance` reports these minus units ingested.
   */
  credit(externalCustomerId: string, units: number): void;
  /**
   * Model `POLAR_METER_ID` being unset: `meterBalance` then reports nothing at
   * all, for any customer.
   */
  setMeterConfigured(configured: boolean): void;
  /**
   * Make exactly the next provider call reject (outage tests). `meterBalance`
   * is the exception — it consumes the failure and reports `null`, because the
   * real provider swallows its own errors rather than break the billing page.
   */
  failNext(message: string): void;
}

const MONTH_MS = 30 * 24 * 3600 * 1000;

/** A payload's `paidAt`, falling back to now when absent or unreadable. */
const paidAtOf = (value: unknown): Date => {
  if (typeof value !== "string") return new Date();
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? new Date() : at;
};

export function createFakeProvider(): FakeProvider {
  const ingested = new Map<string, number>();
  const credited = new Map<string, number>();
  const ingestedIds: string[] = [];
  const seen = new Set<string>();
  let failure: string | null = null;
  let meterConfigured = true;
  let readied = false;

  /** Consume a pending failure without throwing. */
  const swallow = () => {
    const pending = failure !== null;
    failure = null;
    return pending;
  };

  const boom = () => {
    if (failure === null) return;
    const message = failure;
    failure = null;
    throw new Error(message);
  };

  const signRaw = (
    body: string,
    deliveryId: string = randomUUID(),
  ): SignedEvent => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      body,
      deliveryId,
      headers: new Headers({
        "webhook-id": deliveryId,
        "webhook-timestamp": timestamp,
        "webhook-signature": sign(deliveryId, timestamp, body),
      }),
    };
  };

  const signed = (payload: unknown, deliveryId: string): SignedEvent =>
    signRaw(JSON.stringify(payload), deliveryId);

  return {
    id: "fake",
    ingested,
    ingestedIds,
    get readied() {
      return readied;
    },

    /**
     * A no-op, but a real one: the factory must await `ready?.()` on every
     * provider it builds, and this is what lets that be asserted instead of
     * spied on.
     */
    async ready() {
      readied = true;
    },

    async listPlanProducts() {
      boom();
      return CATALOG.map((p) => ({ ...p }));
    },

    async createCheckout({ productId, externalCustomerId }) {
      boom();
      return {
        url: `https://fake.billing.test/checkout/${productId}?customer=${encodeURIComponent(externalCustomerId)}`,
      };
    },

    async createPortalSession({ externalCustomerId }) {
      boom();
      return {
        url: `https://fake.billing.test/portal/${encodeURIComponent(externalCustomerId)}`,
      };
    },

    verifyWebhook(body, headers): VerifyResult {
      const id = headers.get("webhook-id");
      const timestamp = headers.get("webhook-timestamp");
      const sig = headers.get("webhook-signature");
      if (!id || !timestamp || !sig)
        return { ok: false, reason: "missing signature headers" };

      // Standard Webhooks verifies the timestamp *before* the signature, and
      // refuses anything outside the tolerance in either direction. Without
      // this the fake accepts replays the real provider rejects, and the
      // Polar-side replay-window test has no counterpart.
      const sentAt = Number.parseInt(timestamp, 10);
      if (Number.isNaN(sentAt))
        return { ok: false, reason: "invalid signature headers" };
      const skew = Math.floor(Date.now() / 1000) - sentAt;
      if (skew > WEBHOOK_TOLERANCE_SECONDS)
        return { ok: false, reason: "message timestamp too old" };
      if (skew < -WEBHOOK_TOLERANCE_SECONDS)
        return { ok: false, reason: "message timestamp too new" };

      const expected = Buffer.from(sign(id, timestamp, body));
      const given = Buffer.from(sig);
      if (expected.length !== given.length || !timingSafeEqual(expected, given))
        return { ok: false, reason: "bad signature" };

      // A signed body is still attacker-shaped input as far as the caller is
      // concerned, and the interface promises this never throws.
      let parsed: { type?: unknown; data?: unknown };
      try {
        parsed = JSON.parse(body) as { type?: unknown; data?: unknown };
      } catch {
        return { ok: false, reason: "payload is not JSON" };
      }
      if (typeof parsed?.type !== "string")
        return { ok: false, reason: "payload has no event type" };
      const type = parsed.type;
      const data = (parsed.data ?? {}) as Record<string, unknown>;

      // The modelled set, not the prefix — the same dispatch the real provider
      // does. A test that invents a `subscription.*` type has to fail here too,
      // or it proves nothing about production: see the refusal below.
      if (SUBSCRIPTION_TYPES.has(type)) {
        const d = data as unknown as Omit<
          FakeSubscriptionInput,
          "pastDueAt"
        > & {
          currentPeriodStart: string;
          currentPeriodEnd: string;
          modifiedAt: string;
          pastDueAt?: string;
        };
        const metadata = PRODUCT_METADATA[d.productId];
        const hasMeteredPrice =
          d.hasMeteredPrice ??
          CATALOG.find((p) => p.productId === d.productId)?.hasMeteredPrice ??
          false;
        // An explicit `null` in the payload means "uncapped" and must not fall
        // through to the product default, so this checks presence, not
        // nullishness. (`undefined` never survives `JSON.stringify`.)
        const capOverride =
          "overageCapCents" in d ? d.overageCapCents : undefined;
        const subscription: ProviderSubscription = {
          subscriptionId: d.subscriptionId,
          customerId: `cus_${d.externalCustomerId ?? "unknown"}`,
          externalCustomerId: d.externalCustomerId ?? null,
          productId: d.productId,
          status: d.status,
          currentPeriodStart: new Date(d.currentPeriodStart),
          currentPeriodEnd: new Date(d.currentPeriodEnd),
          cancelAtPeriodEnd: d.cancelAtPeriodEnd ?? false,
          modifiedAt: new Date(d.modifiedAt),
          // Straight from the payload, the way the real provider reports its
          // own observation — a fake that stamped `now` here would hide the
          // difference the grace clock depends on.
          pastDueAt: d.pastDueAt ? new Date(d.pastDueAt) : null,
          hasMeteredPrice,
          overageCapCents: !hasMeteredPrice
            ? null
            : capOverride !== undefined
              ? capOverride
              : (PRODUCT_CAP_CENTS[d.productId] ?? null),
          plan: planFromProductMetadata(metadata),
          claimsPlan: claimsPlanMetadata(metadata),
        };
        // The real provider's SDK refuses a payload missing any of these, so
        // the fake must too: handing back `subscriptionId: undefined` and
        // three `Invalid Date`s is exactly the delivery Polar rejects, and a
        // caller tested only against the fake would never see the refusal.
        const defect = subscriptionDefect(subscription);
        if (defect)
          return {
            ok: false,
            reason: `unparseable subscription payload: ${defect}`,
          };
        return {
          ok: true,
          event: { kind: "subscription", deliveryId: id, type, subscription },
        };
      }
      if (type === "order.paid")
        return {
          ok: true,
          event: {
            kind: "order_paid",
            deliveryId: id,
            type,
            subscriptionId: (data.subscriptionId as string) ?? null,
            externalCustomerId: (data.externalCustomerId as string) ?? null,
            // A payload may carry when it was paid, the way a real one does,
            // so a test can replay an *older* order and drive the past-due
            // grace guard into its refusing branch.
            paidAt: paidAtOf(data.paidAt),
          },
        };
      // A subscription-shaped type nobody models is refused rather than
      // dropped, mirroring what the real provider does when its SDK cannot
      // parse one: losing an entitlement change silently is the worse failure.
      if (isSubscriptionType(type))
        return { ok: false, reason: `unmodelled subscription type ${type}` };
      return { ok: true, event: { kind: "ignored", deliveryId: id, type } };
    },

    async ingestUsage(events: UsageEvent[]) {
      boom();
      let inserted = 0;
      let duplicates = 0;
      for (const e of events) {
        if (seen.has(e.externalId)) {
          duplicates++;
          continue;
        }
        seen.add(e.externalId);
        ingestedIds.push(e.externalId);
        ingested.set(
          e.externalCustomerId,
          (ingested.get(e.externalCustomerId) ?? 0) + e.count,
        );
        inserted++;
      }
      return { inserted, duplicates };
    },

    /**
     * Credited minus consumed, counting *down* — the same sense as Polar's
     * `CustomerMeter.balance`, and the opposite of the cumulative total this
     * used to return. A widget built against the old behaviour rendered the
     * right number in tests and the wrong one in production.
     *
     * `null` covers all three ways the real one reports nothing: no meter
     * configured, no meter row for that customer, and a failed call — which
     * is why this consumes a pending `failNext` instead of throwing. The
     * interface promises `meterBalance` never throws.
     */
    async meterBalance(externalCustomerId) {
      if (swallow()) return null;
      if (!meterConfigured) return null;
      const credits = credited.get(externalCustomerId);
      const consumed = ingested.get(externalCustomerId);
      if (credits === undefined && consumed === undefined) return null;
      return (credits ?? 0) - (consumed ?? 0);
    },

    credit(externalCustomerId, units) {
      credited.set(
        externalCustomerId,
        (credited.get(externalCustomerId) ?? 0) + units,
      );
    },

    setMeterConfigured(configured) {
      meterConfigured = configured;
    },

    signSubscriptionEvent(type, sub) {
      const start = sub.currentPeriodStart ?? new Date();
      return signed(
        {
          type,
          data: {
            ...sub,
            currentPeriodStart: start.toISOString(),
            currentPeriodEnd: (
              sub.currentPeriodEnd ?? new Date(start.getTime() + MONTH_MS)
            ).toISOString(),
            modifiedAt: (sub.modifiedAt ?? start).toISOString(),
            ...(sub.pastDueAt && { pastDueAt: sub.pastDueAt.toISOString() }),
          },
        },
        sub.deliveryId ?? randomUUID(),
      );
    },

    signOrderPaidEvent(input) {
      return signed(
        {
          type: "order.paid",
          data: {
            ...input,
            paidAt: (input.paidAt ?? new Date()).toISOString(),
          },
        },
        input.deliveryId ?? randomUUID(),
      );
    },

    signRaw,

    failNext(message) {
      failure = message;
    },
  };
}
