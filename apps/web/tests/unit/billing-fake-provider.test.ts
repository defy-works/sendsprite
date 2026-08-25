import { beforeEach, describe, expect, it } from "vitest";
import { createFakeProvider, type FakeProvider } from "@/services/billing/fake";

let p: FakeProvider;
beforeEach(() => {
  p = createFakeProvider();
});

describe("fake billing provider", () => {
  it("identifies itself as `fake` (the value stored on team_billing.provider)", () => {
    expect(p.id).toBe("fake");
  });

  it("lists the three seeded plan products with their metadata", async () => {
    const products = await p.listPlanProducts();
    expect(products.map((x) => x.plan)).toEqual(["free", "pro", "scale"]);
    const pro = products.find((x) => x.plan === "pro")!;
    expect(pro).toMatchObject({
      includedEmails: 50000,
      overagePer1kCents: 40,
      priceCents: 1200,
      hasMeteredPrice: true,
    });
    expect(pro.productId).toMatch(/^prod_/);
  });

  it("creates a checkout URL carrying the product and the external customer", async () => {
    const { url } = await p.createCheckout({
      productId: "prod_pro",
      externalCustomerId: "org_1",
      successUrl: "https://x.io/done?checkout={CHECKOUT_ID}",
    });
    expect(url).toContain("prod_pro");
    expect(url).toContain("org_1");
  });

  it("creates a portal URL for an external customer", async () => {
    const { url } = await p.createPortalSession({
      externalCustomerId: "org_1",
      returnUrl: "https://x.io/back",
    });
    expect(url).toContain("org_1");
  });

  it("verifies a webhook the fake itself signed and rejects anything else", () => {
    const signed = p.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_1",
      externalCustomerId: "org_1",
      productId: "prod_pro",
      status: "active",
    });
    const ok = p.verifyWebhook(signed.body, signed.headers);
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.event.kind).toBe("subscription");
    if (ok.event.kind !== "subscription") throw new Error("unreachable");
    expect(ok.event.subscription.plan?.plan).toBe("pro");
    expect(ok.event.deliveryId).toBe(signed.deliveryId);

    const bad = p.verifyWebhook(signed.body, new Headers({}));
    expect(bad.ok).toBe(false);
  });

  it("signs across the delivery id and timestamp, not the body alone", () => {
    const signed = p.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_1",
      externalCustomerId: "org_1",
      productId: "prod_pro",
      status: "active",
    });
    // A tampered body, a replayed signature under a new delivery id and a
    // re-stamped timestamp all have to fail, or the fake would let through
    // deliveries the real provider rejects.
    expect(p.verifyWebhook(`${signed.body} `, signed.headers).ok).toBe(false);
    for (const [header, value] of [
      ["webhook-id", "other_delivery"],
      ["webhook-timestamp", "1"],
      ["webhook-signature", "deadbeef"],
    ] as const) {
      const headers = new Headers(signed.headers);
      headers.set(header, value);
      expect(p.verifyWebhook(signed.body, headers).ok).toBe(false);
    }
  });

  it("refuses a correctly signed body that is not JSON instead of throwing", () => {
    const signed = p.signRaw("not json at all");
    const r = p.verifyWebhook(signed.body, signed.headers);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/payload/);
  });

  it("normalises an order.paid delivery and ignores unmodelled types", () => {
    const paid = p.signOrderPaidEvent({
      subscriptionId: "sub_1",
      externalCustomerId: "org_1",
    });
    const r = p.verifyWebhook(paid.body, paid.headers);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.event).toMatchObject({
      kind: "order_paid",
      type: "order.paid",
      subscriptionId: "sub_1",
      externalCustomerId: "org_1",
    });

    const other = p.signRaw(
      JSON.stringify({ type: "benefit.granted", data: {} }),
    );
    const ignored = p.verifyWebhook(other.body, other.headers);
    expect(ignored.ok).toBe(true);
    if (!ignored.ok) throw new Error("unreachable");
    expect(ignored.event).toMatchObject({
      kind: "ignored",
      type: "benefit.granted",
    });
  });

  it("carries the period, cancellation and ordering guard off the payload", () => {
    const start = new Date("2026-08-01T00:00:00.000Z");
    const end = new Date("2026-09-01T00:00:00.000Z");
    const signed = p.signSubscriptionEvent("subscription.updated", {
      subscriptionId: "sub_2",
      externalCustomerId: "org_2",
      productId: "prod_scale",
      status: "past_due",
      currentPeriodStart: start,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: true,
      modifiedAt: new Date("2026-08-15T10:00:00.000Z"),
      deliveryId: "dlv_2",
    });
    const r = p.verifyWebhook(signed.body, signed.headers);
    if (!r.ok || r.event.kind !== "subscription")
      throw new Error("unreachable");
    expect(r.event.deliveryId).toBe("dlv_2");
    expect(r.event.subscription).toMatchObject({
      subscriptionId: "sub_2",
      externalCustomerId: "org_2",
      productId: "prod_scale",
      status: "past_due",
      cancelAtPeriodEnd: true,
      hasMeteredPrice: true,
      claimsPlan: true,
    });
    expect(r.event.subscription.currentPeriodStart).toEqual(start);
    expect(r.event.subscription.currentPeriodEnd).toEqual(end);
    expect(r.event.subscription.modifiedAt).toEqual(
      new Date("2026-08-15T10:00:00.000Z"),
    );
    expect(r.event.subscription.plan).toEqual({
      plan: "scale",
      includedEmails: 300000,
      overagePer1kCents: 25,
    });
  });

  it("can simulate a subscription with no metered price on a metered plan", () => {
    const signed = p.signSubscriptionEvent("subscription.updated", {
      subscriptionId: "sub_3",
      externalCustomerId: "org_3",
      productId: "prod_pro",
      status: "active",
      hasMeteredPrice: false,
    });
    const r = p.verifyWebhook(signed.body, signed.headers);
    if (!r.ok || r.event.kind !== "subscription")
      throw new Error("unreachable");
    expect(r.event.subscription.hasMeteredPrice).toBe(false);
  });

  it("distinguishes a product that is not ours from one whose metadata is broken", () => {
    const foreign = p.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_4",
      externalCustomerId: "org_4",
      productId: "prod_bespoke",
      status: "active",
    });
    const a = p.verifyWebhook(foreign.body, foreign.headers);
    if (!a.ok || a.event.kind !== "subscription")
      throw new Error("unreachable");
    expect(a.event.subscription).toMatchObject({
      plan: null,
      claimsPlan: false,
    });

    // `prod_broken` claims to be Pro but its `included_emails` was cleared in
    // the provider dashboard: unusable, yet not a foreign product. A caller
    // must be able to refuse the downgrade rather than write Free over a paid
    // entitlement.
    const broken = p.signSubscriptionEvent("subscription.updated", {
      subscriptionId: "sub_5",
      externalCustomerId: "org_5",
      productId: "prod_broken",
      status: "active",
    });
    const b = p.verifyWebhook(broken.body, broken.headers);
    if (!b.ok || b.event.kind !== "subscription")
      throw new Error("unreachable");
    expect(b.event.subscription).toMatchObject({
      plan: null,
      claimsPlan: true,
    });
  });

  it("records ingested usage and reports duplicates by externalId", async () => {
    const ev = {
      externalId: "org_1:2026-08-25T09:00:00.000Z",
      externalCustomerId: "org_1",
      name: "email.sent",
      count: 12,
      timestamp: new Date("2026-08-25T09:00:00Z"),
    };
    expect(await p.ingestUsage([ev])).toEqual({ inserted: 1, duplicates: 0 });
    expect(await p.ingestUsage([ev])).toEqual({ inserted: 0, duplicates: 1 });
    expect(p.ingested.get("org_1")).toBe(12);
    expect(p.ingestedIds).toEqual([ev.externalId]);
    expect(await p.meterBalance!("org_1")).toBe(12);
    expect(await p.meterBalance!("org_unknown")).toBe(0);
  });

  it("can be made to fail so callers can be tested against an outage", async () => {
    p.failNext("provider is down");
    await expect(p.ingestUsage([])).rejects.toThrow("provider is down");
    // One failure only: the next call succeeds.
    await expect(p.ingestUsage([])).resolves.toEqual({
      inserted: 0,
      duplicates: 0,
    });
  });

  it("fails the next call whichever call it is", async () => {
    p.failNext("catalog is down");
    await expect(p.listPlanProducts()).rejects.toThrow("catalog is down");
    p.failNext("checkout is down");
    await expect(
      p.createCheckout({
        productId: "prod_pro",
        externalCustomerId: "org_1",
        successUrl: "https://x.io/done",
      }),
    ).rejects.toThrow("checkout is down");
    p.failNext("portal is down");
    await expect(
      p.createPortalSession({
        externalCustomerId: "org_1",
        returnUrl: "https://x.io/back",
      }),
    ).rejects.toThrow("portal is down");
  });

  it("keeps ingest state per instance but signs with a shared secret", () => {
    // The webhook route builds its own provider; a fake built in a test has
    // to be able to sign a delivery that instance will accept.
    const other = createFakeProvider();
    const signed = p.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_x",
      externalCustomerId: "org_1",
      productId: "prod_pro",
      status: "active",
    });
    expect(other.verifyWebhook(signed.body, signed.headers).ok).toBe(true);
    expect(other.ingested.size).toBe(0);
  });
});
