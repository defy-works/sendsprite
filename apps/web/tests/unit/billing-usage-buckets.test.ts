import { afterAll, describe, expect, it } from "vitest";
import {
  MAX_BUCKETS_PER_RUN,
  SETTLE_MS,
  floorHour,
  hourlyBuckets,
  usageExternalId,
} from "@/services/billing/usage";

const iso = (s: string) => new Date(s);

describe("floorHour", () => {
  it("truncates to the UTC hour", () => {
    expect(floorHour(iso("2026-08-25T09:41:37.412Z")).toISOString()).toBe(
      "2026-08-25T09:00:00.000Z",
    );
    expect(floorHour(iso("2026-08-25T09:00:00.000Z")).toISOString()).toBe(
      "2026-08-25T09:00:00.000Z",
    );
  });
});

describe("hourlyBuckets", () => {
  const now = iso("2026-08-25T10:07:00Z");

  it("returns every closed hour from `from` up to the settle horizon", () => {
    // now - 30 min = 09:37, so the last reportable bucket ends at 09:00.
    const b = hourlyBuckets(iso("2026-08-25T07:00:00Z"), now);
    expect(b.map((x) => x.start.toISOString())).toEqual([
      "2026-08-25T07:00:00.000Z",
      "2026-08-25T08:00:00.000Z",
    ]);
    expect(b.at(-1)!.end.toISOString()).toBe("2026-08-25T09:00:00.000Z");
  });

  it("aligns a `from` that is mid-hour down to the hour", () => {
    // A billing period starting at 07:32 is metered from the 07:00 bucket;
    // that bucket's externalId is the same one the previous period already
    // ingested, so the provider deduplicates the overlap for us.
    expect(
      hourlyBuckets(iso("2026-08-25T07:32:00Z"), now)[0]!.start.toISOString(),
    ).toBe("2026-08-25T07:00:00.000Z");
  });

  it("is empty when nothing has settled yet", () => {
    expect(hourlyBuckets(iso("2026-08-25T10:00:00Z"), now)).toEqual([]);
    expect(hourlyBuckets(iso("2026-08-25T09:00:00Z"), now)).toEqual([]);
  });

  it("never returns the hour in progress", () => {
    // Half past the hour is past the settle window, but 10:00 has not closed:
    // reporting it would count a bucket that is still being written to, and
    // the watermark would then step over the rest of it forever.
    const b = hourlyBuckets(
      iso("2026-08-25T08:00:00Z"),
      iso("2026-08-25T10:59:59.999Z"),
    );
    expect(b.at(-1)!.end.toISOString()).toBe("2026-08-25T10:00:00.000Z");
  });

  it("caps a long catch-up so one run cannot blow up", () => {
    const b = hourlyBuckets(iso("2026-01-01T00:00:00Z"), now);
    expect(b).toHaveLength(MAX_BUCKETS_PER_RUN);
    expect(b[0]!.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("the settle window is 30 minutes", () => {
    expect(SETTLE_MS).toBe(30 * 60 * 1000);
  });
});

describe("usageExternalId", () => {
  it("is deterministic per team and bucket", () => {
    expect(usageExternalId("org_1", iso("2026-08-25T09:00:00Z"))).toBe(
      "org_1:2026-08-25T09:00:00.000Z",
    );
    expect(usageExternalId("org_1", iso("2026-08-25T09:00:00Z"))).toBe(
      usageExternalId("org_1", iso("2026-08-25T09:00:00.000Z")),
    );
  });
});

describe("the meter sweep with billing off", () => {
  afterAll(async () => {
    for (const k of ["APP_URL", "APP_SECRET", "DATABASE_URL"])
      delete process.env[k];
    (await import("@/env.schema")).resetEnvCache();
  });

  it("does nothing at all — no provider, no queries; the tick is a no-op", async () => {
    process.env.APP_URL = "https://mail.example.com";
    process.env.APP_SECRET = "x".repeat(40);
    process.env.DATABASE_URL = "postgres://x/y";
    delete process.env.BILLING_ENABLED;
    const { resetEnvCache } = await import("@/env.schema");
    resetEnvCache();

    // `DATABASE_URL` here points nowhere, so a sweep that reached the
    // database would throw rather than return zeros.
    const { runBillingMeterSweep } =
      await import("@/jobs/handlers/billing-meter");
    expect(
      await runBillingMeterSweep(new Date("2026-08-25T10:37:00Z")),
    ).toEqual({ teams: 0, events: 0, units: 0, failed: 0 });
    // The queue *is* registered — unconditionally, so importing this module
    // reads no env — and the handler above is the gate. This used to assert
    // the opposite (no cron on a self-hosted instance), which was bought by
    // an `if (billingConfig().enabled)` around `registerQueue` at module
    // scope: every test that started the worker then depended on APP_URL
    // being set by someone else before this file loaded. One no-op tick an
    // hour is the cheaper end of that trade.
    const boss = (
      globalThis as { __sendspriteBoss?: { registry: Map<string, unknown> } }
    ).__sendspriteBoss;
    expect(boss?.registry.has("billing.meter-sweep") ?? false).toBe(true);
  });
});
