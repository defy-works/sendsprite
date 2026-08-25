import {
  claimsPlanMetadata,
  planFromProductMetadata,
  type PlanMetadata,
} from "@sendsprite/shared";
import {
  BillingUnavailableError,
  PLAN_ORDER,
  type BillingProvider,
  type PlanProduct,
  type ProviderSubscription,
  type UsageEvent,
  type VerifyResult,
} from "./provider";

/**
 * The only module in the repo that knows the provider is Polar.
 *
 * `@polar-sh/sdk` is imported **lazily**, inside `client()`, so an instance
 * running with `BILLING_ENABLED=false` never loads it — that is the whole
 * reason this file has a factory rather than a module-level client. The only
 * static reference to the package is a `import type`, which TypeScript erases,
 * so nothing about the runtime graph changes. Moving this file into a private
 * package later needs no change anywhere else.
 *
 * The *payload* shapes below are re-declared rather than imported from the
 * SDK, narrowed to the fields we read. Two reasons: a minor SDK release cannot
 * break the build over a field we never touch, and the two pure functions here
 * stay drivable from a test with a plain object instead of a 40-field fixture.
 */
import type { Polar } from "@polar-sh/sdk";

/** A price on a product or a subscription, narrowed to what we read. */
export interface PolarPrice {
  amountType?: string;
  /** Fixed recurring amount, in cents. */
  priceAmount?: number | null;
  /** Ceiling on metered charges per cycle, in cents. `null` = uncapped. */
  capAmount?: number | null;
  isArchived?: boolean;
}

/** A catalog product, narrowed to what we read. */
export interface PolarProduct {
  id: string;
  name: string;
  isArchived?: boolean;
  metadata?: unknown;
  prices?: PolarPrice[];
}

/** A subscription, narrowed to what we read. */
export interface PolarSubscription {
  id: string;
  customerId: string;
  productId: string;
  status: string;
  currentPeriodStart: Date | string;
  currentPeriodEnd: Date | string;
  cancelAtPeriodEnd: boolean;
  createdAt: Date | string;
  modifiedAt?: Date | string | null;
  customer?: { id: string; externalId?: string | null };
  product?: PolarProduct;
  /** Prices enabled on the subscription; falls back to the product's. */
  prices?: PolarPrice[];
  metadata?: Record<string, unknown>;
}

export interface PolarOptions {
  accessToken: string;
  /** The raw signing secret from the Polar dashboard, not base64. */
  webhookSecret: string;
  server: "sandbox" | "production";
  /** Used when a usage record carries no name of its own. */
  eventName?: string;
  /** Display only; without it `meterBalance` reports nothing. */
  meterId?: string | null;
}

const live = (p: PolarPrice) => p.isArchived !== true;
const meteredPrice = (prices: PolarPrice[] | undefined) =>
  (prices ?? []).find((p) => live(p) && p.amountType === "metered_unit");
const fixedCents = (prices: PolarPrice[] | undefined) =>
  (prices ?? []).find((p) => live(p) && p.amountType === "fixed")
    ?.priceAmount ?? 0;
const asDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));

/**
 * Catalog to plan products. A product without our metadata is not one of ours
 * and is dropped, so a bespoke enterprise product living in the same
 * organization never appears as a self-serve upgrade — and neither does one of
 * ours whose metadata has been broken in the dashboard, because a plan nobody
 * can price is not something to sell. (Telling those two apart only matters
 * when applying a subscription, which reads `claimsPlan` instead.)
 */
export function planProductsFrom(products: PolarProduct[]): PlanProduct[] {
  const out: PlanProduct[] = [];
  for (const p of products) {
    if (p.isArchived === true) continue;
    const meta = planFromProductMetadata(p.metadata);
    if (!meta) continue;
    out.push({
      productId: p.id,
      name: p.name,
      ...meta,
      priceCents: fixedCents(p.prices),
      hasMeteredPrice: Boolean(meteredPrice(p.prices)),
    });
  }
  return out.sort((a, b) => PLAN_ORDER[a.plan] - PLAN_ORDER[b.plan]);
}

/**
 * Polar subscription to `ProviderSubscription`. The team id is the customer's
 * `externalId`, set at checkout; `metadata.teamId`, copied from the checkout
 * onto the subscription, is the belt-and-braces fallback for a customer
 * created some other way. `modifiedAt` falls back to `createdAt` — a
 * just-created subscription has none, and the ordering guard needs a real
 * timestamp.
 */
export function normalisePolarSubscription(
  s: PolarSubscription,
): ProviderSubscription {
  const metadata = s.product?.metadata;
  const plan: PlanMetadata | null = planFromProductMetadata(metadata);
  const teamId =
    s.customer?.externalId ??
    (typeof s.metadata?.teamId === "string" ? s.metadata.teamId : null);
  const metered = meteredPrice(s.prices ?? s.product?.prices);
  return {
    subscriptionId: s.id,
    customerId: s.customerId,
    externalCustomerId: teamId,
    productId: s.productId,
    status: s.status,
    currentPeriodStart: asDate(s.currentPeriodStart),
    currentPeriodEnd: asDate(s.currentPeriodEnd),
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    modifiedAt: asDate(s.modifiedAt ?? s.createdAt),
    hasMeteredPrice: Boolean(metered),
    overageCapCents: metered?.capAmount ?? null,
    plan,
    claimsPlan: claimsPlanMetadata(metadata),
  };
}

/** Types we act on. Everything else verifies and is recorded as ignored. */
const SUBSCRIPTION_TYPES = new Set([
  "subscription.created",
  "subscription.updated",
  "subscription.active",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.revoked",
  "subscription.past_due",
]);

/** Events per ingest call. Conservative; Polar's own limit is higher. */
export const INGEST_CHUNK = 500;

/**
 * Rolled-up usage to Polar's ingest shape. The count goes in `metadata`, not
 * in a top-level field, because the organization's `emails` meter aggregates
 * **sum over `metadata.count`** — one event per closed hourly bucket rather
 * than one per email is the whole reason metering costs ~720 calls a month
 * instead of 300 000. `externalId` is what makes a retry a no-op.
 */
export function polarUsageEvents(events: UsageEvent[], fallbackName: string) {
  return events.map((e) => ({
    name: e.name || fallbackName,
    externalCustomerId: e.externalCustomerId,
    externalId: e.externalId,
    timestamp: e.timestamp,
    metadata: { count: e.count },
  }));
}

/** What the lazy import resolves to, cached for the life of the provider. */
interface LoadedSdk {
  polar: Polar;
  validate: (
    body: string,
    headers: Record<string, string>,
    secret: string,
  ) => { type: string; timestamp?: Date; data: unknown };
  VerificationError: new (...args: never[]) => Error;
}

export function createPolarProvider(opts: PolarOptions): BillingProvider {
  const eventName = opts.eventName ?? "email.sent";
  let loading: Promise<LoadedSdk> | undefined;
  // `verifyWebhook` is synchronous (the interface says so), so the validator
  // is cached here by the first successful load and `ready()` — awaited by
  // `getBillingProvider()` — makes sure that happened before any delivery.
  let loaded: LoadedSdk | undefined;

  function client(): Promise<LoadedSdk> {
    loading ??= (async () => {
      const [sdkModule, webhooksModule] = await Promise.all([
        import("@polar-sh/sdk"),
        import("@polar-sh/sdk/webhooks"),
      ]);
      const sdk: LoadedSdk = {
        polar: new sdkModule.Polar({
          accessToken: opts.accessToken,
          server: opts.server,
        }),
        validate: webhooksModule.validateEvent as LoadedSdk["validate"],
        VerificationError: webhooksModule.WebhookVerificationError,
      };
      loaded = sdk;
      return sdk;
    })().catch((e: unknown) => {
      // Let the next call retry rather than caching the failure forever.
      loading = undefined;
      throw new BillingUnavailableError(
        `Polar SDK could not be loaded: ${(e as Error).message}`,
      );
    });
    return loading;
  }

  return {
    id: "polar",

    /** Awaited by `getBillingProvider()` so `verifyWebhook` is never cold. */
    async ready() {
      await client();
    },

    async listPlanProducts() {
      const { polar } = await client();
      const items: PolarProduct[] = [];
      // Speakeasy list methods return a page iterator; each page carries
      // `result.items`.
      for await (const page of await polar.products.list({
        isArchived: false,
        isRecurring: true,
        limit: 100,
      }))
        items.push(...page.result.items);
      return planProductsFrom(items);
    },

    async createCheckout({
      productId,
      externalCustomerId,
      customerEmail,
      successUrl,
      metadata,
    }) {
      const { polar } = await client();
      const r = await polar.checkouts.create({
        products: [productId],
        externalCustomerId,
        ...(customerEmail && { customerEmail }),
        successUrl,
        // Copied onto the subscription; the webhook reads it if a customer
        // somehow arrives without an external id.
        metadata: { teamId: externalCustomerId, ...metadata },
      });
      return { url: r.url };
    },

    async createPortalSession({ externalCustomerId, returnUrl }) {
      const { polar } = await client();
      const r = await polar.customerSessions.create({
        externalCustomerId,
        returnUrl,
      });
      return { url: r.customerPortalUrl };
    },

    verifyWebhook(body, headers): VerifyResult {
      const deliveryId = headers.get("webhook-id");
      if (!deliveryId) return { ok: false, reason: "missing webhook-id" };
      if (!loaded) {
        // Warm the cache for the retry; the provider will redeliver.
        void client().catch(() => undefined);
        return { ok: false, reason: "provider SDK not loaded" };
      }
      const { validate, VerificationError } = loaded;
      const signed = {
        "webhook-id": deliveryId,
        "webhook-timestamp": headers.get("webhook-timestamp") ?? "",
        "webhook-signature": headers.get("webhook-signature") ?? "",
      };

      let event: { type: string; timestamp?: Date; data: unknown };
      try {
        event = validate(body, signed, opts.webhookSecret);
      } catch (e) {
        if (e instanceof VerificationError)
          return {
            ok: false,
            reason: (e as Error).message || "invalid signature",
          };
        // Past the signature check: the delivery is authentic, the pinned SDK
        // just cannot model it — a type released after this version, or a
        // payload shape that moved. Refusing would make Polar retry a delivery
        // that can never succeed, so an unmodelled event is recorded and
        // dropped. The exception is a *subscription* event, where dropping one
        // silently loses an entitlement change; that fails loudly instead and
        // shows up in Polar's failed-delivery list.
        const type = typeOf(body);
        if (type === null)
          return { ok: false, reason: "payload is not JSON with a type" };
        if (SUBSCRIPTION_TYPES.has(type))
          return {
            ok: false,
            reason: `unparseable ${type} payload: ${(e as Error).message}`,
          };
        return { ok: true, event: { kind: "ignored", deliveryId, type } };
      }

      if (SUBSCRIPTION_TYPES.has(event.type))
        return {
          ok: true,
          event: {
            kind: "subscription",
            deliveryId,
            type: event.type,
            subscription: normalisePolarSubscription(
              event.data as PolarSubscription,
            ),
          },
        };
      if (event.type === "order.paid") {
        const o = event.data as {
          subscriptionId?: string | null;
          customer?: { externalId?: string | null };
          createdAt?: Date;
        };
        return {
          ok: true,
          event: {
            kind: "order_paid",
            deliveryId,
            type: event.type,
            subscriptionId: o.subscriptionId ?? null,
            externalCustomerId: o.customer?.externalId ?? null,
            paidAt: event.timestamp ?? o.createdAt ?? new Date(),
          },
        };
      }
      return {
        ok: true,
        event: { kind: "ignored", deliveryId, type: event.type },
      };
    },

    async ingestUsage(events: UsageEvent[]) {
      if (events.length === 0) return { inserted: 0, duplicates: 0 };
      const { polar } = await client();
      const payload = polarUsageEvents(events, eventName);
      let inserted = 0;
      let duplicates = 0;
      for (let i = 0; i < payload.length; i += INGEST_CHUNK) {
        const r = await polar.events.ingest({
          events: payload.slice(i, i + INGEST_CHUNK),
        });
        inserted += r.inserted;
        duplicates += r.duplicates;
      }
      return { inserted, duplicates };
    },

    async meterBalance(externalCustomerId) {
      if (!opts.meterId) return null;
      try {
        const { polar } = await client();
        for await (const page of await polar.customerMeters.list({
          externalCustomerId,
          meterId: opts.meterId,
          limit: 1,
        })) {
          const row = page.result.items[0];
          if (row) return row.balance;
        }
        return null;
      } catch {
        // Display only: a provider hiccup must not break the billing page.
        return null;
      }
    },
  };
}

/** The `type` of an already-signature-verified body, or null if unreadable. */
function typeOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const type = (parsed as { type?: unknown } | null)?.type;
    return typeof type === "string" ? type : null;
  } catch {
    return null;
  }
}
