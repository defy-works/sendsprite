import {
  claimsPlanMetadata,
  planFromProductMetadata,
  type PlanMetadata,
} from "@sendsprite/shared";
import {
  BillingUnavailableError,
  isSubscriptionType,
  PLAN_ORDER,
  subscriptionDefect,
  SUBSCRIPTION_TYPES,
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
  /** When Polar put the subscription into `past_due`. */
  pastDueAt?: Date | string | null;
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
  const teamId = teamIdFrom(s.customer?.externalId, s.metadata);
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
    // Polar's own observation of when the charge failed; the grace window is
    // measured from it rather than from when we happened to receive this.
    pastDueAt: s.pastDueAt ? asDate(s.pastDueAt) : null,
    plan,
    claimsPlan: claimsPlanMetadata(metadata),
  };
}

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

/** The webhook validator, cached for the life of the provider. */
interface LoadedWebhooks {
  validate: (
    body: string,
    headers: Record<string, string>,
    secret: string,
  ) => { type: string; timestamp?: Date; data: unknown };
  VerificationError: new (...args: never[]) => Error;
}

export function createPolarProvider(opts: PolarOptions): BillingProvider {
  // Fail fast on an unusable secret, because the failure it causes downstream
  // is silent and severe. `standardwebhooks` builds its key in the `Webhook`
  // constructor, which `validateEvent` runs *outside* its own try/catch, so an
  // empty secret throws a plain `Error("Secret can't be empty.")` rather than a
  // `WebhookVerificationError`. `verifyWebhook` classifies a non-verification
  // throw as "authentic but unmodelled", so every forged delivery would come
  // back `ignored` — 200, a stored event row, and no HMAC ever checked.
  // `env.schema.ts` already refuses `BILLING_ENABLED` without the secret; this
  // is the second lock, because `billingConfig().webhookSecret` is nullable and
  // a caller coercing it to `""` must not be able to disarm verification.
  if (!opts.webhookSecret)
    throw new BillingUnavailableError(
      "POLAR_WEBHOOK_SECRET is empty; refusing to build a provider that cannot verify webhooks",
    );
  if (!opts.accessToken)
    throw new BillingUnavailableError("POLAR_ACCESS_TOKEN is empty");

  const eventName = opts.eventName ?? "email.sent";
  let loadingWebhooks: Promise<LoadedWebhooks> | undefined;
  let loadingClient: Promise<Polar> | undefined;
  // `verifyWebhook` is synchronous (the interface says so), so the validator
  // is cached here by the first successful load and `ready()` — awaited by
  // `getBillingProvider()` — makes sure that happened before any delivery.
  let webhooksReady: LoadedWebhooks | undefined;

  const unavailable = (e: unknown) =>
    new BillingUnavailableError(
      `Polar SDK could not be loaded: ${(e as Error).message}`,
    );

  /**
   * The webhook path loads `@polar-sh/sdk/webhooks` alone rather than the
   * package index: it pulls in the payload schemas and `standardwebhooks`, but
   * none of the HTTP client machinery. This is the one path where a cold start
   * turns into refused deliveries (plan amendment I), so it stays as small as
   * it can be.
   */
  function webhooks(): Promise<LoadedWebhooks> {
    loadingWebhooks ??= import("@polar-sh/sdk/webhooks")
      .then((m) => {
        const loaded: LoadedWebhooks = {
          validate: m.validateEvent as LoadedWebhooks["validate"],
          VerificationError: m.WebhookVerificationError,
        };
        webhooksReady = loaded;
        return loaded;
      })
      .catch((e: unknown) => {
        // Let the next call retry rather than caching the failure forever.
        loadingWebhooks = undefined;
        throw unavailable(e);
      });
    return loadingWebhooks;
  }

  /** The API client, loaded only when an API call is actually made. */
  function client(): Promise<Polar> {
    loadingClient ??= import("@polar-sh/sdk")
      .then(
        (m) =>
          new m.Polar({ accessToken: opts.accessToken, server: opts.server }),
      )
      .catch((e: unknown) => {
        loadingClient = undefined;
        throw unavailable(e);
      });
    return loadingClient;
  }

  return {
    id: "polar",

    /**
     * Awaited by `getBillingProvider()` so `verifyWebhook` is never cold. Only
     * the validator is warmed; the API client loads on its first call, which is
     * inside an `await` anyway.
     */
    async ready() {
      await webhooks();
    },

    async listPlanProducts() {
      const polar = await client();
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
      const polar = await client();
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
      const polar = await client();
      const r = await polar.customerSessions.create({
        externalCustomerId,
        returnUrl,
      });
      return { url: r.customerPortalUrl };
    },

    verifyWebhook(body, headers): VerifyResult {
      const deliveryId = headers.get("webhook-id");
      if (!deliveryId) return { ok: false, reason: "missing webhook-id" };
      if (!webhooksReady) {
        // Warm the cache for the retry; the provider will redeliver.
        void webhooks().catch(() => undefined);
        return { ok: false, reason: "provider SDK not loaded" };
      }
      const { validate, VerificationError } = webhooksReady;
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
        // Keyed on the `subscription.` *prefix*, not on the modelled set: the
        // day Polar ships a subscription type this SDK predates, the pinned
        // parser throws `Unknown event type` and the delivery would otherwise
        // be dropped as `ignored` — an entitlement change lost, which is the
        // one thing amendment J forbids.
        if (isSubscriptionType(type))
          return {
            ok: false,
            reason: `unparseable ${type} payload: ${(e as Error).message}`,
          };
        return { ok: true, event: { kind: "ignored", deliveryId, type } };
      }

      if (SUBSCRIPTION_TYPES.has(event.type)) {
        const subscription = normalisePolarSubscription(
          event.data as PolarSubscription,
        );
        // Belt and braces: the SDK's schema should already have refused a
        // payload missing any of these, and the fake enforces the same
        // invariant. Writing an `Invalid Date` into the period columns is not
        // a failure worth being relaxed about.
        const defect = subscriptionDefect(subscription);
        if (defect)
          return {
            ok: false,
            reason: `unparseable ${event.type} payload: ${defect}`,
          };
        return {
          ok: true,
          event: {
            kind: "subscription",
            deliveryId,
            type: event.type,
            subscription,
          },
        };
      }
      if (event.type === "order.paid") {
        const o = event.data as {
          subscriptionId?: string | null;
          customer?: { externalId?: string | null };
          metadata?: Record<string, unknown>;
          createdAt?: Date;
        };
        return {
          ok: true,
          event: {
            kind: "order_paid",
            deliveryId,
            type: event.type,
            subscriptionId: o.subscriptionId ?? null,
            // Same two sources, in the same order, as
            // `normalisePolarSubscription`: a customer created outside our
            // checkout has no external id, and the `teamId` we copy onto every
            // checkout is the fallback. Reading only one of them here would
            // orphan exactly the orders the subscription path can still place.
            externalCustomerId: teamIdFrom(o.customer?.externalId, o.metadata),
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
      const polar = await client();
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
        const polar = await client();
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

/**
 * Our team id off a Polar payload: the customer's `externalId`, set at
 * checkout, falling back to the `teamId` the checkout copies onto the
 * resulting objects' metadata for a customer created some other way.
 */
function teamIdFrom(
  externalId: string | null | undefined,
  metadata: Record<string, unknown> | undefined,
): string | null {
  if (typeof externalId === "string" && externalId) return externalId;
  const fromMetadata = metadata?.teamId;
  return typeof fromMetadata === "string" && fromMetadata ? fromMetadata : null;
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
