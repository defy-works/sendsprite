import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";
import { createFakeProvider, type FakeProvider } from "@/services/billing/fake";

let pg: Awaited<ReturnType<typeof startPg>>;
let provider: FakeProvider;
beforeAll(async () => {
  pg = await startPg();
  process.env.BILLING_ENABLED = "1";
  process.env.BILLING_PROVIDER = "fake";
  provider = createFakeProvider();
});
afterAll(async () => {
  await pg.stop();
  delete process.env.BILLING_ENABLED;
  delete process.env.BILLING_PROVIDER;
});

const PERIOD_START = new Date("2026-08-25T00:00:00Z");
const PERIOD_END = new Date("2026-09-25T00:00:00Z");
/**
 * 10:37 — the 09:00 bucket closed at 10:00 and has now cleared the 30-minute
 * settle window; the 10:00 bucket has not closed at all. (The cron fires at
 * :07, so this is the tick that reports the hour before last.)
 */
const NOW = new Date("2026-08-25T10:37:00Z");

async function seedTeam(
  period: { start: Date; end: Date } = {
    start: PERIOD_START,
    end: PERIOD_END,
  },
) {
  const { db } = await import("@/db");
  const { teamBilling } = await import("@/db/schema");
  const { team } = await seedTeamWithKey();
  await db()
    .insert(teamBilling)
    .values({
      teamId: team.id,
      provider: "fake",
      providerCustomerId: `cus_${team.id}`,
      subscriptionId: `sub_${team.id}`,
      plan: "pro",
      status: "active",
      includedEmails: 50000,
      overagePer1kCents: 40,
      overageEnabled: true,
      periodStart: period.start,
      periodEnd: period.end,
      providerModifiedAt: period.start,
    });
  return team;
}

async function seedEmails(teamId: string, at: Date, n: number) {
  const { db } = await import("@/db");
  const { emails } = await import("@/db/schema");
  const { newId } = await import("@sendsprite/shared");
  await db()
    .insert(emails)
    .values(
      Array.from({ length: n }, () => ({
        id: newId("em"),
        teamId,
        from: "a@b.io",
        fromEmail: "a@b.io",
        to: ["c@d.io"],
        subject: "s",
        status: "sent" as const,
        createdAt: at,
      })),
    );
}

describe("rollupUsage", () => {
  it("emits one event per non-empty settled hour and advances the watermark", async () => {
    const { rollupUsage, usageRow } = await import("@/services/billing/usage");
    const team = await seedTeam();
    await seedEmails(team.id, new Date("2026-08-25T08:10:00Z"), 3);
    await seedEmails(team.id, new Date("2026-08-25T08:50:00Z"), 2);
    await seedEmails(team.id, new Date("2026-08-25T09:30:00Z"), 4);
    // Not settled yet: the 10:00 hour has not closed.
    await seedEmails(team.id, new Date("2026-08-25T10:01:00Z"), 9);

    const s = await rollupUsage(provider, "email.sent", NOW);
    expect(s).toMatchObject({ events: 2, units: 9, failed: 0 });
    expect(provider.ingestedIds).toEqual(
      expect.arrayContaining([
        `${team.id}:2026-08-25T08:00:00.000Z`,
        `${team.id}:2026-08-25T09:00:00.000Z`,
      ]),
    );
    expect(provider.ingested.get(team.id)).toBe(9);
    const row = (await usageRow(team.id, PERIOD_START))!;
    expect(row.reportedThrough!.toISOString()).toBe("2026-08-25T10:00:00.000Z");
    expect(row.reportedUnits).toBe(9);
  });

  it("is a no-op on the second run — nothing new has settled", async () => {
    const { rollupUsage } = await import("@/services/billing/usage");
    const before = provider.ingestedIds.length;
    expect(await rollupUsage(provider, "email.sent", NOW)).toMatchObject({
      events: 0,
    });
    expect(provider.ingestedIds).toHaveLength(before);
  });

  it("a provider outage advances nothing, and the retry does not double-count", async () => {
    const { rollupUsage, usageRow } = await import("@/services/billing/usage");
    const team = await seedTeam();
    await seedEmails(team.id, new Date("2026-08-25T08:15:00Z"), 5);

    provider.failNext("provider is down");
    const failed = await rollupUsage(provider, "email.sent", NOW);
    expect(failed.failed).toBeGreaterThan(0);
    expect(await usageRow(team.id, PERIOD_START)).toBeUndefined();
    expect(provider.ingested.get(team.id)).toBeUndefined();

    const ok = await rollupUsage(provider, "email.sent", NOW);
    expect(ok.failed).toBe(0);
    expect(provider.ingested.get(team.id)).toBe(5);
    expect((await usageRow(team.id, PERIOD_START))!.reportedUnits).toBe(5);
  });

  it("re-sending a bucket after a lost response does not double-bill", async () => {
    // Simulates the dangerous case: the provider stored the events but we
    // never saw the 2xx, so the watermark did not move and the same buckets
    // are sent again. The deterministic externalId makes the second send a
    // duplicate rather than a second charge.
    const { planTeamRollup } = await import("@/services/billing/usage");
    const team = await seedTeam();
    await seedEmails(team.id, new Date("2026-08-25T08:20:00Z"), 6);
    const r = (await planTeamRollup(
      team.id,
      PERIOD_START,
      PERIOD_END,
      "email.sent",
      NOW,
    ))!;
    expect(await provider.ingestUsage(r.events)).toMatchObject({ inserted: 1 });
    expect(await provider.ingestUsage(r.events)).toMatchObject({
      inserted: 0,
      duplicates: 1,
    });
    expect(provider.ingested.get(team.id)).toBe(6);
  });

  it("ignores teams that never went through checkout", async () => {
    const { rollupUsage } = await import("@/services/billing/usage");
    const { team } = await seedTeamWithKey();
    await seedEmails(team.id, new Date("2026-08-25T08:00:00Z"), 100);
    await rollupUsage(provider, "email.sent", NOW);
    expect(provider.ingested.get(team.id)).toBeUndefined();
  });

  it("counts only billable statuses", async () => {
    const { planTeamRollup } = await import("@/services/billing/usage");
    const { db } = await import("@/db");
    const { emails } = await import("@/db/schema");
    const { newId } = await import("@sendsprite/shared");
    const team = await seedTeam();
    const at = new Date("2026-08-25T08:00:00Z");
    await seedEmails(team.id, at, 2);
    for (const status of ["failed", "cancelled"] as const)
      await db()
        .insert(emails)
        .values({
          id: newId("em"),
          teamId: team.id,
          from: "a@b.io",
          fromEmail: "a@b.io",
          to: ["c@d.io"],
          subject: "s",
          status,
          createdAt: at,
        });
    const r = (await planTeamRollup(
      team.id,
      PERIOD_START,
      PERIOD_END,
      "email.sent",
      NOW,
    ))!;
    expect(r.units).toBe(2);
  });

  it("does not lose the hour a renewal lands in", async () => {
    // The renewal moves `period_start` forward mid-hour. `reported_through`
    // is behind it by construction — only settled hours are ever reported —
    // so a per-period watermark read would restart at the new period start
    // and abandon the bucket in between. Once per team per cycle, silently.
    const { rollupUsage } = await import("@/services/billing/usage");
    const { db } = await import("@/db");
    const { billingUsage, teamBilling } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const oldStart = new Date("2026-07-25T14:23:00Z");
    const renewal = new Date("2026-08-25T14:23:00Z");
    const team = await seedTeam({ start: oldStart, end: renewal });
    // Caught up to noon by the runs earlier in the cycle.
    await db()
      .insert(billingUsage)
      .values({
        teamId: team.id,
        periodStart: oldStart,
        periodEnd: renewal,
        reportedThrough: new Date("2026-08-25T12:00:00Z"),
        reportedUnits: 0,
      });
    // 12:00 settles before the renewal; 13:00 is the hour the renewal lands in.
    await seedEmails(team.id, new Date("2026-08-25T12:30:00Z"), 3);
    await seedEmails(team.id, new Date("2026-08-25T13:30:00Z"), 7);
    await rollupUsage(provider, "email.sent", new Date("2026-08-25T13:40:00Z"));
    expect(provider.ingested.get(team.id)).toBe(3);

    // The renewal webhook lands: the period moves to 14:23.
    await db()
      .update(teamBilling)
      .set({
        periodStart: renewal,
        periodEnd: new Date("2026-09-25T14:23:00Z"),
      })
      .where(eq(teamBilling.teamId, team.id));

    await rollupUsage(provider, "email.sent", new Date("2026-08-25T15:40:00Z"));
    expect(provider.ingestedIds).toContain(
      `${team.id}:2026-08-25T13:00:00.000Z`,
    );
    expect(provider.ingested.get(team.id)).toBe(10);
  });

  it("keys usage on the stored period, not the entitlement's substitute", async () => {
    // A stored period that does not contain `now` — a renewal webhook that
    // has not landed. `entitlementFrom` substitutes a window of its own for
    // it, and keying the watermark off that would start a second usage row
    // for hours the first already counted and re-emit the whole period.
    const { rollupUsage, usageRow } = await import("@/services/billing/usage");
    const { calendarMonth, entitlementFrom, meteringPeriodStart } =
      await import("@/services/billing/plans");
    const { db } = await import("@/db");
    const { billingUsage, teamBilling } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    const STALE_START = new Date("2026-07-20T00:00:00Z");
    const STALE_END = new Date("2026-08-20T00:00:00Z");
    const team = await seedTeam({ start: STALE_START, end: STALE_END });
    const [row] = await db()
      .select()
      .from(teamBilling)
      .where(eq(teamBilling.teamId, team.id));
    // The premise: entitlement really does substitute a window of its own —
    // the stored period rolled forward onto its next anniversary, which is
    // neither the stored start nor the calendar month.
    const rolled = entitlementFrom(row!, NOW).periodStart;
    expect(rolled.toISOString()).toBe("2026-08-20T00:00:00.000Z");
    expect(rolled.toISOString()).not.toBe(
      calendarMonth(NOW).start.toISOString(),
    );
    expect(rolled.toISOString()).not.toBe(STALE_START.toISOString());
    // The metering key does not move with it.
    expect(meteringPeriodStart(row!, NOW).toISOString()).toBe(
      STALE_START.toISOString(),
    );

    await rollupUsage(provider, "email.sent", NOW);
    expect(await usageRow(team.id, STALE_START)).toBeDefined();
    // Neither substitute window opened a row of its own.
    expect(await usageRow(team.id, rolled)).toBeUndefined();
    expect(await usageRow(team.id, calendarMonth(NOW).start)).toBeUndefined();

    // And a second run still finds the same row rather than opening another.
    await rollupUsage(provider, "email.sent", NOW);
    const rows = await db()
      .select()
      .from(billingUsage)
      .where(eq(billingUsage.teamId, team.id));
    expect(rows).toHaveLength(1);
  });
});
