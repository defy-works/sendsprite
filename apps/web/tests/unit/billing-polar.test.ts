import { beforeAll, describe, expect, it } from "vitest";
import { Webhook } from "standardwebhooks";
import { SubscriptionStatus } from "@polar-sh/sdk/models/components/subscriptionstatus.js";
import { SUBSCRIPTION_STATUSES } from "@sendsprite/shared";
import {
  BillingUnavailableError,
  isSubscriptionType,
  subscriptionDefect,
  SUBSCRIPTION_TYPES,
} from "@/services/billing/provider";
import {
  createPolarProvider,
  normalisePolarSubscription,
  planProductsFrom,
  polarUsageEvents,
  type PolarProduct,
  type PolarSubscription,
} from "@/services/billing/polar";

/**
 * `validateEvent` base64-encodes the secret it is handed before building the
 * Standard Webhooks key, so the raw string here is what `POLAR_WEBHOOK_SECRET`
 * holds and the signer below has to be given the base64 form to match.
 */
const SECRET = "polar-test-secret";
const SIGNER = new Webhook(Buffer.from(SECRET, "utf-8").toString("base64"));

const PRO_PRODUCT: PolarProduct = {
  id: "b1a20e03-8474-49fb-aec2-d1b13cb7467e",
  name: "Sendsprite Pro",
  isArchived: false,
  metadata: { plan: "pro", included_emails: 50000, overage_per_1k_cents: 40 },
  prices: [
    { amountType: "fixed", priceAmount: 1200, isArchived: false },
    { amountType: "metered_unit", capAmount: 20000, isArchived: false },
  ],
};

const BESPOKE_PRODUCT: PolarProduct = {
  id: "zzz",
  name: "Bespoke",
  isArchived: false,
  metadata: { note: "not one of ours" },
  prices: [{ amountType: "fixed", priceAmount: 999900, isArchived: false }],
};

describe("SUBSCRIPTION_STATUSES", () => {
  it("matches the SDK's own status set", () => {
    // The shared constant is documentation, not validation — nothing parses
    // against it. This is the only place the claim is checked, and it is here
    // rather than in `@sendsprite/shared` because that package must stay free
    // of a provider dependency. If a future `@polar-sh/sdk` adds or drops a
    // status, this fails and the constant gets updated with it.
    expect([...SUBSCRIPTION_STATUSES]).toEqual(
      Object.values(SubscriptionStatus),
    );
  });
});

describe("SUBSCRIPTION_TYPES", () => {
  it("is the seven subscription payloads @polar-sh/sdk@0.49.0 models", () => {
    expect([...SUBSCRIPTION_TYPES].sort()).toEqual([
      "subscription.active",
      "subscription.canceled",
      "subscription.created",
      "subscription.past_due",
      "subscription.revoked",
      "subscription.uncanceled",
      "subscription.updated",
    ]);
    // Every member is subscription-shaped, so the dispatch set is a subset of
    // what the prefix-based refusal covers. That containment is the invariant
    // that makes an unmodelled `subscription.*` refused rather than dropped.
    for (const t of SUBSCRIPTION_TYPES)
      expect(isSubscriptionType(t)).toBe(true);
    expect(isSubscriptionType("order.paid")).toBe(false);
  });
});

describe("subscriptionDefect", () => {
  // The invariant both implementations enforce: Polar gets it from its SDK's
  // schema, the fake has to be told, and this is the one definition of it.
  const usable = normalisePolarSubscription({
    id: "sub_1",
    customerId: "cus_1",
    productId: PRO_PRODUCT.id,
    status: "active",
    currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    product: PRO_PRODUCT,
  });

  it("passes a normalised subscription", () => {
    expect(subscriptionDefect(usable)).toBeNull();
  });

  it("names the missing identifier or the unreadable date", () => {
    expect(subscriptionDefect({ ...usable, subscriptionId: "" })).toBe(
      "missing subscriptionId",
    );
    expect(subscriptionDefect({ ...usable, productId: "" })).toBe(
      "missing productId",
    );
    expect(subscriptionDefect({ ...usable, status: "" })).toBe(
      "missing status",
    );
    expect(
      subscriptionDefect({ ...usable, currentPeriodEnd: new Date("nope") }),
    ).toBe("invalid currentPeriodEnd");
    expect(
      subscriptionDefect({ ...usable, modifiedAt: new Date("nope") }),
    ).toBe("invalid modifiedAt");
  });
});

describe("planProductsFrom", () => {
  it("keeps only products carrying our metadata", () => {
    expect(planProductsFrom([BESPOKE_PRODUCT, PRO_PRODUCT])).toEqual([
      {
        productId: "b1a20e03-8474-49fb-aec2-d1b13cb7467e",
        name: "Sendsprite Pro",
        plan: "pro",
        priceCents: 1200,
        includedEmails: 50000,
        overagePer1kCents: 40,
        hasMeteredPrice: true,
      },
    ]);
  });

  it("orders the catalog cheapest plan first", () => {
    const free: PolarProduct = {
      ...PRO_PRODUCT,
      id: "f",
      metadata: {
        plan: "free",
        included_emails: 3000,
        overage_per_1k_cents: 0,
      },
    };
    const scale: PolarProduct = {
      ...PRO_PRODUCT,
      id: "s",
      metadata: {
        plan: "scale",
        included_emails: 300000,
        overage_per_1k_cents: 25,
      },
    };
    expect(
      planProductsFrom([scale, PRO_PRODUCT, free]).map((p) => p.plan),
    ).toEqual(["free", "pro", "scale"]);
  });

  it("drops archived products and ignores archived prices", () => {
    const archivedPrice: PolarProduct = {
      ...PRO_PRODUCT,
      prices: [
        { amountType: "fixed", priceAmount: 1200, isArchived: false },
        { amountType: "metered_unit", capAmount: 20000, isArchived: true },
      ],
    };
    expect(planProductsFrom([archivedPrice])[0]!.hasMeteredPrice).toBe(false);
    expect(planProductsFrom([{ ...PRO_PRODUCT, isArchived: true }])).toEqual(
      [],
    );
  });

  it("keeps a product whose plan metadata is broken out of the catalog", () => {
    // `planFromProductMetadata` refuses a cleared `included_emails`; a product
    // nobody can price is not offered as an upgrade. Only `applySubscription`
    // has to tell this case apart from a foreign product, and it reads
    // `claimsPlan` off the subscription to do it.
    expect(
      planProductsFrom([
        {
          ...PRO_PRODUCT,
          metadata: {
            plan: "pro",
            included_emails: "",
            overage_per_1k_cents: 40,
          },
        },
      ]),
    ).toEqual([]);
  });
});

describe("normalisePolarSubscription", () => {
  const sub: PolarSubscription = {
    id: "sub_1",
    customerId: "cus_1",
    productId: PRO_PRODUCT.id,
    status: "active",
    currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    modifiedAt: new Date("2026-08-02T00:00:00Z"),
    customer: { id: "cus_1", externalId: "org_abc" },
    product: PRO_PRODUCT,
    prices: PRO_PRODUCT.prices,
    metadata: {},
  };

  it("reads the team from the customer's external id and the plan from metadata", () => {
    const out = normalisePolarSubscription(sub);
    expect(out).toMatchObject({
      subscriptionId: "sub_1",
      customerId: "cus_1",
      externalCustomerId: "org_abc",
      productId: PRO_PRODUCT.id,
      status: "active",
      hasMeteredPrice: true,
      claimsPlan: true,
      plan: { plan: "pro", includedEmails: 50000, overagePer1kCents: 40 },
    });
    expect(out.modifiedAt.toISOString()).toBe("2026-08-02T00:00:00.000Z");
  });

  it("carries the metered price's spend ceiling when there is one", () => {
    // `cap_amount` lives on the Polar price, not in product metadata; nothing
    // in this app enforces it, but the billing page can state it.
    expect(normalisePolarSubscription(sub).overageCapCents).toBe(20000);
    expect(
      normalisePolarSubscription({
        ...sub,
        prices: [{ amountType: "metered_unit", capAmount: null }],
      }).overageCapCents,
    ).toBeNull();
    // No metered price at all: no ceiling to report.
    expect(
      normalisePolarSubscription({
        ...sub,
        prices: [{ amountType: "fixed", priceAmount: 1200 }],
      }),
    ).toMatchObject({ hasMeteredPrice: false, overageCapCents: null });
  });

  it("falls back to the product's prices when the subscription carries none", () => {
    expect(
      normalisePolarSubscription({ ...sub, prices: undefined }),
    ).toMatchObject({ hasMeteredPrice: true, overageCapCents: 20000 });
  });

  it("falls back to subscription.metadata.teamId when there is no external id", () => {
    expect(
      normalisePolarSubscription({
        ...sub,
        customer: { id: "cus_1", externalId: null },
        metadata: { teamId: "org_fallback" },
      }).externalCustomerId,
    ).toBe("org_fallback");
    expect(
      normalisePolarSubscription({
        ...sub,
        customer: { id: "cus_1", externalId: null },
        metadata: {},
      }).externalCustomerId,
    ).toBeNull();
  });

  it("falls back to createdAt when modifiedAt is null", () => {
    expect(
      normalisePolarSubscription({
        ...sub,
        modifiedAt: null,
      }).modifiedAt.toISOString(),
    ).toBe("2026-07-01T00:00:00.000Z");
  });

  it("distinguishes a foreign product from one whose metadata is broken", () => {
    expect(
      normalisePolarSubscription({ ...sub, product: BESPOKE_PRODUCT }),
    ).toMatchObject({ plan: null, claimsPlan: false });
    expect(
      normalisePolarSubscription({
        ...sub,
        product: {
          ...PRO_PRODUCT,
          metadata: { plan: "pro", included_emails: "" },
        },
      }),
    ).toMatchObject({ plan: null, claimsPlan: true });
  });
});

describe("polarUsageEvents", () => {
  const ev = {
    externalId: "org_1:2026-08-25T09:00:00.000Z",
    externalCustomerId: "org_1",
    name: "email.sent",
    count: 12,
    timestamp: new Date("2026-08-25T09:00:00Z"),
  };

  it("puts the count in metadata, which is what the shared meter sums", () => {
    expect(polarUsageEvents([ev], "fallback.name")).toEqual([
      {
        name: "email.sent",
        externalCustomerId: "org_1",
        externalId: "org_1:2026-08-25T09:00:00.000Z",
        timestamp: new Date("2026-08-25T09:00:00Z"),
        metadata: { count: 12 },
      },
    ]);
  });

  it("falls back to the configured event name when the record carries none", () => {
    expect(
      polarUsageEvents([{ ...ev, name: "" }], "fallback.name")[0]!.name,
    ).toBe("fallback.name");
  });
});

describe("polar webhook verification", () => {
  const provider = createPolarProvider({
    accessToken: "t",
    webhookSecret: SECRET,
    server: "sandbox",
  });

  beforeAll(async () => {
    // `verifyWebhook` is synchronous, so the lazily imported validator has to
    // be warm before the first delivery. The factory awaits this.
    await provider.ready?.();
  });

  const deliver = (payload: unknown, id = "msg_1") => {
    const body = JSON.stringify(payload);
    const timestamp = new Date();
    return {
      body,
      headers: new Headers({
        "webhook-id": id,
        "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "webhook-signature": SIGNER.sign(id, timestamp, body),
      }),
    };
  };

  it("rejects a tampered body", () => {
    const { body, headers } = deliver({ type: "order.paid", data: {} });
    expect(provider.verifyWebhook(`${body} `, headers).ok).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(provider.verifyWebhook("{}", new Headers({})).ok).toBe(false);
    const { body, headers } = deliver({ type: "order.paid", data: {} });
    headers.delete("webhook-signature");
    expect(provider.verifyWebhook(body, headers).ok).toBe(false);
  });

  it("rejects a delivery whose timestamp is outside the replay window", () => {
    const body = JSON.stringify({ type: "order.paid", data: {} });
    const old = new Date(Date.now() - 3600_000);
    const r = provider.verifyWebhook(
      body,
      new Headers({
        "webhook-id": "msg_old",
        "webhook-timestamp": String(Math.floor(old.getTime() / 1000)),
        "webhook-signature": SIGNER.sign("msg_old", old, body),
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a signature minted for a different delivery id", () => {
    // Standard Webhooks binds id and timestamp into the signed material, so a
    // captured signature cannot be replayed under a new delivery id.
    const { body, headers } = deliver({ type: "order.paid", data: {} });
    headers.set("webhook-id", "msg_replayed");
    expect(provider.verifyWebhook(body, headers).ok).toBe(false);
  });

  it("normalises an unmodelled type to `ignored` rather than failing", () => {
    // The signature is good; the SDK simply does not know the type. Failing
    // here would make the provider retry a delivery that can never succeed.
    const { body, headers } = deliver(
      { type: "payout.created", data: { id: "po_1" } },
      "msg_unknown",
    );
    const r = provider.verifyWebhook(body, headers);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.event).toEqual({
      kind: "ignored",
      deliveryId: "msg_unknown",
      type: "payout.created",
    });
  });

  it("treats a known-but-unparseable type as ignored too", () => {
    const { body, headers } = deliver(
      { type: "benefit.created", data: { id: "ben_1" } },
      "msg_benefit",
    );
    const r = provider.verifyWebhook(body, headers);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.event).toMatchObject({ kind: "ignored", type: "benefit.created" });
  });

  it("refuses a subscription event the SDK cannot parse instead of silently dropping it", () => {
    // The one exception to the rule above: a subscription delivery we cannot
    // read is a real entitlement change going missing, so it fails loudly and
    // the provider's retry (and failed-delivery list) surfaces it.
    const { body, headers } = deliver(
      { type: "subscription.updated", data: { id: "sub_1" } },
      "msg_bad_sub",
    );
    const r = provider.verifyWebhook(body, headers);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/subscription/i);
  });

  it("refuses to exist without a webhook secret", () => {
    // `standardwebhooks` throws a plain `Error` from the `Webhook` constructor
    // on an empty secret, and that constructor runs outside `validateEvent`'s
    // try. Classified as "authentic but unmodelled", a forged delivery would
    // come back `ignored` with no HMAC ever checked — so the provider refuses
    // to be built at all rather than verify nothing.
    expect(() =>
      createPolarProvider({
        accessToken: "t",
        webhookSecret: "",
        server: "sandbox",
      }),
    ).toThrow(BillingUnavailableError);
    expect(() =>
      createPolarProvider({
        accessToken: "",
        webhookSecret: SECRET,
        server: "sandbox",
      }),
    ).toThrow(/POLAR_ACCESS_TOKEN/);
  });

  it("normalises a real subscription delivery end to end", () => {
    const { body, headers } = deliver(
      subscriptionPayload("subscription.updated"),
      "msg_sub",
    );
    const r = provider.verifyWebhook(body, headers);
    expect(r.ok).toBe(true);
    if (!r.ok || r.event.kind !== "subscription")
      throw new Error("unreachable");
    expect(r.event.deliveryId).toBe("msg_sub");
    expect(r.event.type).toBe("subscription.updated");
    expect(r.event.subscription).toMatchObject({
      subscriptionId: "sub_live",
      customerId: "cus_live",
      externalCustomerId: "org_live",
      productId: PRO_PRODUCT.id,
      status: "past_due",
      cancelAtPeriodEnd: false,
      hasMeteredPrice: true,
      overageCapCents: 20000,
      claimsPlan: true,
      plan: { plan: "pro", includedEmails: 50000, overagePer1kCents: 40 },
    });
    expect(r.event.subscription.currentPeriodStart).toEqual(
      new Date("2026-08-01T00:00:00.000Z"),
    );
    expect(r.event.subscription.modifiedAt).toEqual(
      new Date("2026-08-15T10:00:00.000Z"),
    );
  });

  it("normalises order.paid, reading the team off the customer", () => {
    const { body, headers } = deliver(orderPaidPayload(), "msg_order");
    const r = provider.verifyWebhook(body, headers);
    expect(r.ok).toBe(true);
    if (!r.ok || r.event.kind !== "order_paid") throw new Error("unreachable");
    expect(r.event).toMatchObject({
      deliveryId: "msg_order",
      type: "order.paid",
      subscriptionId: "sub_live",
      externalCustomerId: "org_live",
    });
    expect(r.event.paidAt).toEqual(new Date("2026-08-15T10:00:00.000Z"));
  });

  it("refuses a subscription type the SDK does not model, rather than ignoring it", () => {
    // The refusal keys off the `subscription.` prefix, not the modelled set,
    // so a type Polar ships after this SDK was pinned is still refused loudly.
    // `payout.created` above proves the other half: unknown *and* not
    // subscription-shaped is ignored.
    const { body, headers } = deliver(
      { type: "subscription.trialing", data: { id: "sub_1" } },
      "msg_future_sub",
    );
    const r = provider.verifyWebhook(body, headers);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/subscription\.trialing/);
  });

  it("reads the team off order metadata when the customer has no external id", () => {
    const base = orderPaidPayload();
    const payload = {
      ...base,
      data: {
        ...base.data,
        customer: { ...CUSTOMER, external_id: null },
        metadata: { teamId: "org_from_metadata" },
      },
    };
    const { body, headers } = deliver(payload, "msg_order_meta");
    const r = provider.verifyWebhook(body, headers);
    if (!r.ok || r.event.kind !== "order_paid") throw new Error("unreachable");
    expect(r.event.externalCustomerId).toBe("org_from_metadata");
  });

  it("is not verifiable before the SDK has loaded", () => {
    const cold = createPolarProvider({
      accessToken: "t",
      webhookSecret: SECRET,
      server: "sandbox",
    });
    const { body, headers } = deliver({ type: "order.paid", data: {} });
    const r = cold.verifyWebhook(body, headers);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/not loaded/);
  });
});

/* ---------------------------------------------------------------------- *
 * Wire fixtures. These are the provider's own snake_case JSON, not our
 * normalised shape, so `@polar-sh/sdk`'s parser is genuinely exercised —
 * the point of these two is that a payload the pinned SDK accepts really
 * does map to the fields the billing service reads.
 * ---------------------------------------------------------------------- */

const CUSTOMER = {
  id: "cus_live",
  created_at: "2026-07-01T00:00:00Z",
  modified_at: null,
  metadata: {},
  external_id: "org_live",
  email: "billing@example.com",
  email_verified: true,
  type: "individual",
  name: "Example",
  billing_name: null,
  billing_address: null,
  tax_id: null,
  organization_id: "org_polar",
  deleted_at: null,
  avatar_url: null,
};

const WIRE_PRODUCT = {
  id: PRO_PRODUCT.id,
  created_at: "2026-07-01T00:00:00Z",
  modified_at: null,
  trial_interval: null,
  trial_interval_count: null,
  name: "Sendsprite Pro",
  description: null,
  visibility: "public",
  recurring_interval: "month",
  recurring_interval_count: 1,
  meter_interval: "month",
  meter_interval_count: 1,
  is_recurring: true,
  is_archived: false,
  organization_id: "org_polar",
  metadata: { plan: "pro", included_emails: 50000, overage_per_1k_cents: 40 },
  prices: [
    {
      created_at: "2026-07-01T00:00:00Z",
      modified_at: null,
      id: "price_fixed",
      source: "catalog",
      amount_type: "fixed",
      price_currency: "usd",
      tax_behavior: null,
      is_archived: false,
      product_id: PRO_PRODUCT.id,
      price_amount: 1200,
    },
    {
      created_at: "2026-07-01T00:00:00Z",
      modified_at: null,
      id: "price_metered",
      source: "catalog",
      amount_type: "metered_unit",
      price_currency: "usd",
      tax_behavior: null,
      is_archived: false,
      product_id: PRO_PRODUCT.id,
      unit_amount: "0.040000000000",
      cap_amount: 20000,
      meter_id: "fb2f372a-f6a8-4697-93d6-adab7f76e4ad",
      meter: {
        id: "fb2f372a-f6a8-4697-93d6-adab7f76e4ad",
        name: "emails",
        unit: "scalar",
        custom_label: null,
        custom_multiplier: null,
      },
    },
  ],
  benefits: [],
  medias: [],
  attached_custom_fields: [],
};

const subscriptionPayload = (type: string) => ({
  type,
  timestamp: "2026-08-15T10:00:00Z",
  data: {
    created_at: "2026-07-01T00:00:00Z",
    modified_at: "2026-08-15T10:00:00Z",
    id: "sub_live",
    amount: 1200,
    currency: "usd",
    recurring_interval: "month",
    recurring_interval_count: 1,
    status: "past_due",
    current_period_start: "2026-08-01T00:00:00Z",
    current_period_end: "2026-09-01T00:00:00Z",
    current_meter_period_start: "2026-08-01T00:00:00Z",
    current_meter_period_end: "2026-09-01T00:00:00Z",
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    started_at: "2026-07-01T00:00:00Z",
    ends_at: null,
    ended_at: null,
    past_due_at: "2026-08-15T10:00:00Z",
    pause_at_period_end: false,
    paused_at: null,
    resumes_at: null,
    customer_id: "cus_live",
    product_id: PRO_PRODUCT.id,
    discount_id: null,
    checkout_id: null,
    customer_cancellation_reason: null,
    customer_cancellation_comment: null,
    metadata: { teamId: "org_live" },
    customer: CUSTOMER,
    product: WIRE_PRODUCT,
    discount: null,
    prices: WIRE_PRODUCT.prices,
    meters: [],
    pending_update: null,
  },
});

const orderPaidPayload = () => ({
  type: "order.paid",
  timestamp: "2026-08-15T10:00:00Z",
  data: {
    // Deliberately *not* the envelope timestamp: `paidAt` is load-bearing for
    // the past-due clear guard, so the assertion has to be able to tell which
    // of the two it came from.
    created_at: "2026-08-14T09:00:00Z",
    modified_at: null,
    id: "ord_1",
    status: "paid",
    paid: true,
    subtotal_amount: 1200,
    discount_amount: 0,
    net_amount: 1200,
    tax_amount: 0,
    total_amount: 1200,
    applied_balance_amount: 0,
    due_amount: 1200,
    refunded_amount: 0,
    refunded_tax_amount: 0,
    currency: "usd",
    billing_reason: "subscription_cycle",
    billing_name: null,
    billing_address: null,
    invoice_number: null,
    is_invoice_generated: false,
    receipt_number: null,
    customer_id: "cus_live",
    product_id: PRO_PRODUCT.id,
    discount_id: null,
    subscription_id: "sub_live",
    checkout_id: null,
    metadata: {},
    platform_fee_amount: 0,
    platform_fee_currency: "usd",
    customer: CUSTOMER,
    product: null,
    discount: null,
    subscription: null,
    items: [],
    description: "Sendsprite Pro",
    refundable_amount: 1200,
    refundable_tax_amount: 0,
  },
});
