import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";
import { createFakeProvider, type FakeProvider } from "@/services/billing/fake";

let pg: Awaited<ReturnType<typeof startPg>>;
/**
 * The route builds its *own* provider through `getBillingProvider()`. This one
 * only signs: the fake's signing secret is a module constant, so a delivery
 * signed here verifies against the instance the route built for itself —
 * which is the point, since a test that handed the route its provider would
 * never exercise the wiring.
 */
let provider: FakeProvider;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_URL = "http://localhost:3000";
  process.env.BILLING_ENABLED = "1";
  process.env.BILLING_PROVIDER = "fake";
  const { resetEnvCache } = await import("@/env.schema");
  const { resetBillingProvider } = await import("@/services/billing");
  resetEnvCache();
  resetBillingProvider();
  provider = createFakeProvider();
});
afterAll(async () => {
  await pg.stop();
  delete process.env.BILLING_ENABLED;
  delete process.env.BILLING_PROVIDER;
});

const URL_ = "http://localhost:3000/api/billing/webhook";
const post = (body: string, headers: Headers) =>
  new Request(URL_, { method: "POST", headers, body });

/**
 * A body with no `content-length` — what a chunked delivery looks like. The
 * `Request` constructor stamps a length on a string body, so the second cap
 * (the one that guards a chunked request) is only reachable through a stream.
 */
const chunked = (body: string) =>
  new Request(URL_, {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    }),
    // Required by undici for a streamed request body; not in the DOM types.
    duplex: "half",
  } as RequestInit);

const route = () => import("@/app/api/billing/webhook/route");

const subscription = (over: Record<string, unknown> = {}) =>
  provider.signSubscriptionEvent("subscription.created", {
    subscriptionId: "sub_route",
    externalCustomerId: "org_missing",
    productId: "prod_pro",
    status: "active",
    ...over,
  });

describe("POST /api/billing/webhook", () => {
  it("200s a verified delivery and applies it", async () => {
    const { POST } = await route();
    const { billingRow } = await import("@/services/billing/plans");
    const { team } = await seedTeamWithKey();
    const e = subscription({ externalCustomerId: team.id });
    const res = await POST(post(e.body, e.headers));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, applied: true });
    expect((await billingRow(team.id))!.plan).toBe("pro");
  });

  it("200s a redelivery without applying it twice", async () => {
    const { POST } = await route();
    const { team } = await seedTeamWithKey();
    const e = subscription({
      externalCustomerId: team.id,
      subscriptionId: "sub_dup",
      deliveryId: "whd_dup",
    });
    expect((await POST(post(e.body, e.headers))).status).toBe(200);
    const res = await POST(post(e.body, e.headers));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      received: true,
      applied: false,
      duplicate: true,
    });
  });

  it("200s a verified delivery of a type we do not model", async () => {
    const { POST } = await route();
    const e = provider.signRaw(
      JSON.stringify({ type: "customer.created", data: {} }),
    );
    const res = await POST(post(e.body, e.headers));
    // Authentic but unmodelled: refusing it would make the provider retry
    // forever something that can never apply.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      received: true,
      applied: false,
      reason: "unmodelled_type",
    });
  });

  it("200s a verified delivery it skips", async () => {
    const { POST } = await route();
    const e = subscription({ subscriptionId: "sub_nobody" });
    const res = await POST(post(e.body, e.headers));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      received: true,
      applied: false,
      reason: "unknown_team",
    });
  });

  it("403s a bad signature", async () => {
    const { POST } = await route();
    const e = subscription();
    // One trailing byte: the signature covers the exact bytes, so this is a
    // tampered delivery, not a different one.
    const res = await POST(post(`${e.body} `, e.headers));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: "forbidden" },
    });
  });

  it("403s a delivery with no signature headers at all", async () => {
    const { POST } = await route();
    const e = subscription();
    expect((await POST(post(e.body, new Headers()))).status).toBe(403);
  });

  it("413s an oversized body from content-length alone", async () => {
    const { POST } = await route();
    const headers = new Headers({ "content-length": String(200_000) });
    const res = await POST(post("{}", headers));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: { code: "payload_too_large" },
    });
  });

  it("413s an oversized body that declares no length", async () => {
    const { POST } = await route();
    const res = await POST(chunked("x".repeat(70_000)));
    expect(res.status).toBe(413);
  });

  it("500s when handling throws, so the provider retries", async () => {
    vi.resetModules();
    vi.doMock("@/services/billing", async () => ({
      ...(await vi.importActual<typeof import("@/services/billing")>(
        "@/services/billing",
      )),
      handleProviderEvent: () => {
        throw new Error("database is on fire");
      },
    }));
    try {
      const { POST } = await route();
      const e = subscription();
      const res = await POST(post(e.body, e.headers));
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({
        error: { code: "internal_error" },
      });
    } finally {
      vi.doUnmock("@/services/billing");
      vi.resetModules();
    }
  });

  it("404s when billing is disabled", async () => {
    const { resetEnvCache } = await import("@/env.schema");
    const { resetBillingProvider } = await import("@/services/billing");
    delete process.env.BILLING_ENABLED;
    resetEnvCache();
    resetBillingProvider();
    try {
      const { POST } = await route();
      const e = subscription();
      // Even a perfectly signed delivery: a self-hosted instance must not
      // expose an endpoint it has no use for.
      const res = await POST(post(e.body, e.headers));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    } finally {
      process.env.BILLING_ENABLED = "1";
      resetEnvCache();
      resetBillingProvider();
    }
  });
});
