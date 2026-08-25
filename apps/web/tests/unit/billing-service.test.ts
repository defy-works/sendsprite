import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/env.schema";
import { getBillingProvider, resetBillingProvider } from "@/services/billing";
import type { FakeProvider } from "@/services/billing/fake";

const BASE = {
  APP_URL: "https://mail.example.com",
  APP_SECRET: "x".repeat(40),
  DATABASE_URL: "postgres://x/y",
};

const withEnv = (extra: Record<string, string>) => {
  Object.assign(process.env, BASE, extra);
  resetEnvCache();
};

afterEach(() => {
  for (const k of [
    ...Object.keys(BASE),
    "BILLING_ENABLED",
    "BILLING_PROVIDER",
    "POLAR_ACCESS_TOKEN",
    "POLAR_WEBHOOK_SECRET",
  ])
    delete process.env[k];
  resetEnvCache();
  resetBillingProvider();
});

const headers = (id: string) =>
  new Headers({
    "webhook-id": id,
    "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
    "webhook-signature": "v1,not-a-real-signature",
  });

describe("getBillingProvider", () => {
  it("refuses when billing is off", async () => {
    withEnv({});
    await expect(getBillingProvider()).rejects.toThrow(/not enabled/i);
  });

  it("builds the fake once when the instance is configured for it", async () => {
    withEnv({ BILLING_ENABLED: "1", BILLING_PROVIDER: "fake" });
    const a = await getBillingProvider();
    expect(a.id).toBe("fake");
    expect(await getBillingProvider()).toBe(a);
    resetBillingProvider();
    expect(await getBillingProvider()).not.toBe(a);
  });

  it("warms the fake too, so a test written against it is not blind", async () => {
    // The amendment is about whatever provider is configured. A factory that
    // returns early on the fake branch would make every later test that drives
    // billing through the fake unable to see a regression in the await.
    withEnv({ BILLING_ENABLED: "1", BILLING_PROVIDER: "fake" });
    const provider = (await getBillingProvider()) as FakeProvider;
    expect(provider.readied).toBe(true);
  });

  it("does not cache a provider that failed to warm", async () => {
    // A transient SDK-load failure at boot must not be sticky for the life of
    // the process: the warming await happens inside the memoised promise, so
    // its rejection has to evict the entry like any other build failure.
    let attempts = 0;
    vi.doMock("@/services/billing/polar", () => ({
      createPolarProvider: () => ({
        id: "polar",
        ready: async () => {
          if (++attempts === 1) throw new Error("cold start failed");
        },
        listPlanProducts: async () => [],
        createCheckout: async () => ({ url: "" }),
        createPortalSession: async () => ({ url: "" }),
        verifyWebhook: () => ({ ok: false, reason: "stub" }),
        ingestUsage: async () => ({ inserted: 0, duplicates: 0 }),
      }),
    }));
    withEnv({
      BILLING_ENABLED: "1",
      BILLING_PROVIDER: "polar",
      POLAR_ACCESS_TOKEN: "polar_at_test",
      POLAR_WEBHOOK_SECRET: "whsec_test",
    });
    const { getBillingProvider: get } = await import("@/services/billing");
    await expect(get()).rejects.toThrow(/cold start failed/);
    // The retry rebuilds rather than handing back the provider that never warmed.
    expect((await get()).id).toBe("polar");
    expect(attempts).toBe(2);
    vi.doUnmock("@/services/billing/polar");
    vi.resetModules();
  });

  it("warms the provider so the first webhook after a cold start is not refused", async () => {
    // The Polar SDK is imported lazily, and `verifyWebhook` is synchronous: an
    // unwarmed provider answers "provider SDK not loaded" and every first
    // delivery after a deploy fails. Awaiting `ready?.()` in the factory is
    // what prevents that, so this asserts the *first* verification gets as far
    // as a real signature check.
    withEnv({
      BILLING_ENABLED: "1",
      BILLING_PROVIDER: "polar",
      POLAR_ACCESS_TOKEN: "polar_at_test",
      POLAR_WEBHOOK_SECRET: "whsec_test",
    });
    const provider = await getBillingProvider();
    expect(provider.id).toBe("polar");
    const r = provider.verifyWebhook(
      JSON.stringify({ type: "subscription.updated", data: {} }),
      headers("cold_1"),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).not.toMatch(/SDK not loaded/i);
  });
});
