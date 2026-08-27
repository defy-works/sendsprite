import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/env.schema";
import { defaultCatalogLoader, resetBillingProvider } from "@/services/billing";
import type { PlanProduct } from "@/services/billing/provider";

/**
 * The provider the loader will resolve to. Mocked at the module the fake is
 * built from, because the real fake answers instantly and the whole point here
 * is what happens when nothing answers at all.
 */
const stub = vi.hoisted(() => ({
  listPlanProducts: vi.fn(),
  ready: vi.fn(async () => {}),
}));
/** Counts how many times the provider was actually constructed. */
const createFakeProvider = vi.hoisted(() => vi.fn(() => stub));
vi.mock("@/services/billing/fake", () => ({ createFakeProvider }));

const never = () => new Promise<never>(() => {});

const product: PlanProduct = {
  productId: "prod_pro",
  name: "Pro",
  plan: "pro",
  priceCents: 1200,
  includedEmails: 50000,
  overagePer1kCents: 40,
  hasMeteredPrice: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(process.env, {
    APP_URL: "https://mail.example.com",
    APP_SECRET: "x".repeat(40),
    DATABASE_URL: "postgres://x/y",
    BILLING_ENABLED: "1",
    BILLING_PROVIDER: "fake",
  });
  resetEnvCache();
  stub.ready.mockImplementation(async () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const k of [
    "APP_URL",
    "APP_SECRET",
    "DATABASE_URL",
    "BILLING_ENABLED",
    "BILLING_PROVIDER",
  ])
    delete process.env[k];
  resetEnvCache();
  resetBillingProvider();
});

describe("defaultCatalogLoader", () => {
  it("returns the catalog and leaves no timer behind", async () => {
    stub.listPlanProducts.mockResolvedValue([product]);
    await expect(defaultCatalogLoader()).resolves.toEqual([product]);
    // A live timer would hold the event loop open for the whole timeout on
    // every single refresh — five seconds added to every process exit.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects after five seconds when the provider never answers", async () => {
    // The case this exists for: a hung socket would otherwise pin the catalog
    // cache's single in-flight promise for ever, and every send waiting on a
    // cap would hang behind it.
    stub.listPlanProducts.mockImplementation(never);
    const p = defaultCatalogLoader();
    const settled = p.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(4999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toMatch(/timed out after 5000ms/);
  });

  it("bounds a provider that never finishes warming up", async () => {
    // The clock has to start before `getBillingProvider()` is awaited: the
    // first call in a process lazily imports the SDK and awaits `ready()`, and
    // a hang there is just as capable of pinning the cache as a hung list.
    stub.ready.mockImplementation(never);
    stub.listPlanProducts.mockResolvedValue([product]);
    const settled = defaultCatalogLoader().catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await settled).toMatch(/timed out after 5000ms/);
    expect(stub.listPlanProducts).not.toHaveBeenCalled();
  });

  it("drops the memoised provider on a timeout so the next call rebuilds it", async () => {
    // `getBillingProvider` memoises the promise it is building, and a `ready()`
    // that hangs never rejects — so without the reset that promise stays
    // pending for the life of the process and every later refresh awaits the
    // same dead object. The cache would back off for a TTL and then find
    // nothing had recovered, for ever.
    stub.ready.mockImplementation(never);
    const first = defaultCatalogLoader().catch(() => "timed out");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await first).toBe("timed out");
    expect(createFakeProvider).toHaveBeenCalledTimes(1);

    // The next refresh builds a fresh provider rather than awaiting the hung one.
    stub.ready.mockImplementation(async () => {});
    stub.listPlanProducts.mockResolvedValue([product]);
    await expect(defaultCatalogLoader()).resolves.toEqual([product]);
    expect(createFakeProvider).toHaveBeenCalledTimes(2);
    expect(stub.ready).toHaveBeenCalledTimes(2);
  });

  it("propagates a provider error rather than waiting out the timeout", async () => {
    stub.listPlanProducts.mockRejectedValue(new Error("polar down"));
    await expect(defaultCatalogLoader()).rejects.toThrow("polar down");
    expect(vi.getTimerCount()).toBe(0);
  });
});
