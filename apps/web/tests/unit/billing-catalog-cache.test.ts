import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanProduct } from "@/services/billing/provider";
import {
  CATALOG_TTL_MS,
  cachedPlanIncluded,
  resetCatalogCacheForTests,
  setCatalogClockForTests,
} from "@/services/billing/catalog-cache";

const product = (
  plan: "free" | "pro" | "scale",
  includedEmails: number,
): PlanProduct => ({
  productId: `prod_${plan}`,
  name: plan,
  plan,
  priceCents: 0,
  includedEmails,
  overagePer1kCents: 0,
  hasMeteredPrice: false,
});

/** A mutable fake clock, wired to the cache's clock seam. */
function fakeClock(startMs: number) {
  let now = startMs;
  setCatalogClockForTests(() => now);
  return { set: (ms: number) => (now = ms) };
}

afterEach(() => resetCatalogCacheForTests());

describe("cachedPlanIncluded", () => {
  it("loads once and serves from memory inside the TTL", async () => {
    const list = vi.fn(async () => [product("pro", 50000)]);
    const t0 = Date.parse("2026-08-27T10:00:00Z");
    const clock = fakeClock(t0);

    expect(await cachedPlanIncluded("pro", list)).toBe(50000);
    clock.set(t0 + CATALOG_TTL_MS - 1);
    expect(await cachedPlanIncluded("pro", list)).toBe(50000);
    expect(list).toHaveBeenCalledTimes(1);

    clock.set(t0 + CATALOG_TTL_MS);
    await cachedPlanIncluded("pro", list);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good value when a refresh fails, and pushes the next attempt out", async () => {
    const list = vi
      .fn<() => Promise<PlanProduct[]>>()
      .mockResolvedValueOnce([product("scale", 300000)])
      .mockRejectedValueOnce(new Error("polar down"));
    const t0 = Date.parse("2026-08-27T10:00:00Z");
    const clock = fakeClock(t0);

    expect(await cachedPlanIncluded("scale", list)).toBe(300000);

    // The refresh at t0+TTL fails; the value must survive it.
    clock.set(t0 + CATALOG_TTL_MS);
    expect(await cachedPlanIncluded("scale", list)).toBe(300000);
    expect(list).toHaveBeenCalledTimes(2);

    // The failed attempt still pushes the next one out by a full TTL: one
    // millisecond later must not retry yet.
    clock.set(t0 + CATALOG_TTL_MS + 1);
    expect(await cachedPlanIncluded("scale", list)).toBe(300000);
    expect(list).toHaveBeenCalledTimes(2);

    // A full TTL after the failed attempt, it retries.
    clock.set(t0 + 2 * CATALOG_TTL_MS);
    await cachedPlanIncluded("scale", list);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("dedupes concurrent calls behind a single in-flight refresh", async () => {
    let release!: (products: PlanProduct[]) => void;
    const gate = new Promise<PlanProduct[]>((resolve) => (release = resolve));
    const list = vi.fn(() => gate);
    fakeClock(Date.parse("2026-08-27T10:00:00Z"));

    const a = cachedPlanIncluded("pro", list);
    const b = cachedPlanIncluded("pro", list);
    release([product("pro", 50000)]);

    expect(await a).toBe(50000);
    expect(await b).toBe(50000);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("undefined for a plan the catalog lacks", async () => {
    fakeClock(Date.parse("2026-08-27T10:00:00Z"));
    expect(
      await cachedPlanIncluded("pro", async () => [product("free", 3000)]),
    ).toBeUndefined();
  });

  it("undefined when nothing has ever loaded", async () => {
    fakeClock(Date.parse("2026-08-27T10:00:00Z"));
    expect(
      await cachedPlanIncluded("pro", async () => {
        throw new Error("x");
      }),
    ).toBeUndefined();
  });

  it("backs off after a failed cold-start load, with no cache to fall back on", async () => {
    const list = vi.fn().mockRejectedValue(new Error("polar down"));
    const t0 = Date.parse("2026-08-27T10:00:00Z");
    const clock = fakeClock(t0);

    expect(await cachedPlanIncluded("pro", list)).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(1);

    // Immediately after: still within the backoff window, no retry.
    clock.set(t0 + 1);
    expect(await cachedPlanIncluded("pro", list)).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(1);
  });
});
