import { beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createFakeProvider, type FakeProvider } from "@/services/billing/fake";

/**
 * Re-sign a body for an arbitrary timestamp. The fake's signer always stamps
 * `now`, so a skew test has to reach for the same HMAC it uses.
 */
function signHeaderFor(
  deliveryId: string,
  timestamp: string,
  body: string,
): string {
  return createHmac("sha256", "fake-billing-secret")
    .update(`${deliveryId}.${timestamp}.${body}`)
    .digest("hex");
}

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

  it("reports the per-cycle overage ceiling the way a real price carries it", () => {
    const cap = (input: Parameters<typeof p.signSubscriptionEvent>[1]) => {
      const signed = p.signSubscriptionEvent("subscription.updated", input);
      const r = p.verifyWebhook(signed.body, signed.headers);
      if (!r.ok || r.event.kind !== "subscription")
        throw new Error("unreachable");
      return r.event.subscription.overageCapCents;
    };
    const base = {
      subscriptionId: "sub_cap",
      externalCustomerId: "org_cap",
      status: "active",
    };
    // The sandbox caps Pro at $200 a cycle and Scale at $500.
    expect(cap({ ...base, productId: "prod_pro" })).toBe(20000);
    expect(cap({ ...base, productId: "prod_scale" })).toBe(50000);
    // An explicit `null` is "uncapped", not "use the default".
    expect(cap({ ...base, productId: "prod_pro", overageCapCents: null })).toBe(
      null,
    );
    expect(cap({ ...base, productId: "prod_pro", overageCapCents: 999 })).toBe(
      999,
    );
    // No metered price, no ceiling — and Free never has one.
    expect(
      cap({ ...base, productId: "prod_pro", hasMeteredPrice: false }),
    ).toBeNull();
    expect(cap({ ...base, productId: "prod_free" })).toBeNull();
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

  it("refuses an unmodelled subscription type, the way the real provider does", () => {
    // The fake and the Polar provider dispatch on the same `SUBSCRIPTION_TYPES`
    // from the seam. Were the fake to accept any `subscription.*`, a test
    // written against an invented type would pass here and be refused in
    // production — the seam would be lying.
    const signed = p.signSubscriptionEvent("subscription.trialing", {
      subscriptionId: "sub_future",
      externalCustomerId: "org_future",
      productId: "prod_pro",
      status: "trialing",
    });
    const r = p.verifyWebhook(signed.body, signed.headers);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/subscription\.trialing/);
  });

  it("refuses a malformed subscription payload, the way the SDK does", () => {
    // Polar's SDK refuses this delivery outright. Before, the fake returned
    // `ok: true` with `subscriptionId: undefined` and three `Invalid Date`s,
    // so anything tested only against the fake never met the refusal.
    for (const data of [
      {},
      { subscriptionId: "", productId: "prod_pro", status: "active" },
      { subscriptionId: "sub_1", productId: "prod_pro" },
      {
        subscriptionId: "sub_1",
        productId: "prod_pro",
        status: "active",
        currentPeriodStart: "not-a-date",
        currentPeriodEnd: "2026-09-01T00:00:00.000Z",
        modifiedAt: "2026-08-01T00:00:00.000Z",
      },
    ]) {
      const e = p.signRaw(
        JSON.stringify({ type: "subscription.updated", data }),
      );
      const r = p.verifyWebhook(e.body, e.headers);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.reason).toMatch(/unparseable subscription payload/);
    }
  });

  it("refuses a delivery outside the replay window, in both directions", () => {
    const stale = (offsetSeconds: number) => {
      const body = JSON.stringify({ type: "order.paid", data: {} });
      const timestamp = String(Math.floor(Date.now() / 1000) - offsetSeconds);
      // Signed correctly for that timestamp: only its age is wrong.
      const id = "dlv_skew";
      const signed = p.signRaw(body, id);
      const headers = new Headers({
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": signHeaderFor(id, timestamp, body),
      });
      return p.verifyWebhook(signed.body, headers);
    };
    expect(stale(3600).ok).toBe(false);
    expect(stale(-3600).ok).toBe(false);
    // Inside the tolerance it still verifies.
    expect(stale(60).ok).toBe(true);
  });

  it("stamps order.paid with the payload's own paidAt", () => {
    const paidAt = new Date("2026-08-03T00:00:00.000Z");
    const e = p.signOrderPaidEvent({
      subscriptionId: "sub_j",
      externalCustomerId: "org_1",
      paidAt,
    });
    const r = p.verifyWebhook(e.body, e.headers);
    if (!r.ok || r.event.kind !== "order_paid") throw new Error("unreachable");
    expect(r.event.paidAt).toEqual(paidAt);

    // Absent, it is stamped now — which is why a replay of an older invoice
    // could not be staged through a signed delivery before.
    const now = p.signOrderPaidEvent({
      subscriptionId: "sub_j",
      externalCustomerId: "org_1",
    });
    const r2 = p.verifyWebhook(now.body, now.headers);
    if (!r2.ok || r2.event.kind !== "order_paid")
      throw new Error("unreachable");
    expect(r2.event.paidAt.getTime()).toBeGreaterThan(paidAt.getTime());
  });

  it("reports a meter balance that counts down, the way Polar's does", async () => {
    const ev = (externalId: string, count: number) => ({
      externalId,
      externalCustomerId: "org_1",
      name: "email.sent",
      count,
      timestamp: new Date(),
    });
    // No meter row for a customer nobody has credited or metered.
    expect(await p.meterBalance!("org_1")).toBeNull();

    p.credit("org_1", 50000);
    expect(await p.meterBalance!("org_1")).toBe(50000);
    await p.ingestUsage([ev("a", 12)]);
    // Credited minus consumed: it counts *down*, and can go negative.
    expect(await p.meterBalance!("org_1")).toBe(49988);
    await p.ingestUsage([ev("b", 60000)]);
    expect(await p.meterBalance!("org_1")).toBe(-10012);
    // Usage with no credit is a real row, and is negative from the start.
    await p.ingestUsage([{ ...ev("c", 5), externalCustomerId: "org_2" }]);
    expect(await p.meterBalance!("org_2")).toBe(-5);
  });

  it("reports nothing when no meter is configured, and never throws", async () => {
    p.credit("org_1", 10);
    p.setMeterConfigured(false);
    expect(await p.meterBalance!("org_1")).toBeNull();
    p.setMeterConfigured(true);
    expect(await p.meterBalance!("org_1")).toBe(10);

    // The real provider swallows its own errors rather than break the billing
    // page, so an outage here is `null`, not a rejection.
    p.failNext("meters are down");
    await expect(p.meterBalance!("org_1")).resolves.toBeNull();
    // The failure was consumed, not queued for the next call.
    expect(await p.meterBalance!("org_1")).toBe(10);
  });

  it("records `ready()` so the factory can be held to awaiting it", async () => {
    expect(p.readied).toBe(false);
    await p.ready?.();
    expect(p.readied).toBe(true);
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
    // Consumed with nothing credited: the balance is negative, and a customer
    // with no meter row at all reports nothing.
    expect(await p.meterBalance!("org_1")).toBe(-12);
    expect(await p.meterBalance!("org_unknown")).toBeNull();
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
