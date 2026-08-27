import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_URL = "http://localhost:3000";
  process.env.APP_SECRET = "x".repeat(40);
});
afterAll(async () => {
  await pg.stop();
  delete process.env.BILLING_ENABLED;
  delete process.env.BILLING_PROVIDER;
});

const NOW = new Date("2026-08-15T12:00:00Z");

const enableBilling = async () => {
  process.env.BILLING_ENABLED = "1";
  process.env.BILLING_PROVIDER = "fake";
  (await import("@/env.schema")).resetEnvCache();
};
const disableBilling = async () => {
  delete process.env.BILLING_ENABLED;
  (await import("@/env.schema")).resetEnvCache();
};

/** Insert `n` billable emails created at `at`. */
async function seedEmails(teamId: string, n: number, at = NOW) {
  if (n === 0) return;
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

async function seedPlan(
  teamId: string,
  over: Partial<{
    plan: "free" | "pro" | "scale";
    status: string;
    includedEmails: number;
    overageEnabled: boolean;
    periodStart: Date;
    periodEnd: Date;
  }> = {},
) {
  const { db } = await import("@/db");
  const { teamBilling } = await import("@/db/schema");
  const periodStart = over.periodStart ?? new Date("2026-08-10T00:00:00Z");
  await db()
    .insert(teamBilling)
    .values({
      teamId,
      plan: over.plan ?? "pro",
      status: over.status ?? "active",
      includedEmails: over.includedEmails ?? 50000,
      overagePer1kCents: 40,
      overageEnabled: over.overageEnabled ?? true,
      periodStart,
      periodEnd: over.periodEnd ?? new Date("2026-09-10T00:00:00Z"),
      providerModifiedAt: periodStart,
    });
}

describe("plan entitlements feed the existing caps", () => {
  it("billing off: no plan cap, today's behaviour exactly", async () => {
    await disableBilling();
    const { checkTeamCaps, resolveTeamCaps } =
      await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    await seedEmails(team.id, 5);
    expect(await resolveTeamCaps(team.id, NOW)).toMatchObject({
      daily: null,
      monthly: null,
      source: "none",
    });
    expect(await checkTeamCaps(team.id, 1, NOW)).toEqual({ ok: true });
  });

  it("billing off: a team_billing row is ignored entirely", async () => {
    await disableBilling();
    const { checkTeamCaps, resolveTeamCaps, usageSnapshot } =
      await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    // A row left behind by a hosted-to-self-hosted restore must not cap.
    await seedPlan(team.id, { overageEnabled: false, includedEmails: 1 });
    await seedEmails(team.id, 5);
    expect(await resolveTeamCaps(team.id, NOW)).toMatchObject({
      daily: null,
      monthly: null,
      source: "none",
      planName: null,
    });
    expect(await checkTeamCaps(team.id, 1000, NOW)).toEqual({ ok: true });
    const u = await usageSnapshot(team.id, NOW);
    expect(u).toMatchObject({ dailyLimit: null, monthlyLimit: null });
    // The instance-wide branch is still the one that runs when nothing caps.
    expect(u.accountUsed).toBe(0); // no `sent_at` on the seeded rows
  });

  it("billing off: the rate headers are exactly what they are today", async () => {
    await disableBilling();
    const { rateHeaders } = await import("@/lib/api-response");
    const { db } = await import("@/db");
    const { teamSettings } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    await seedPlan(team.id, { overageEnabled: false });
    await seedEmails(team.id, 4);
    // No team_settings, no SES quota: unlimited, and no plan cap leaks in.
    expect(await rateHeaders(team.id, NOW)).toEqual({
      "x-ratelimit-limit": "unlimited",
      "x-ratelimit-remaining": "unlimited",
    });
    await db().insert(teamSettings).values({ teamId: team.id, dailyLimit: 10 });
    expect(await rateHeaders(team.id, NOW)).toEqual({
      "x-ratelimit-limit": "10",
      "x-ratelimit-remaining": "6",
      "x-ratelimit-reset": String(Math.floor(Date.UTC(2026, 7, 16) / 1000)),
    });
  });

  it("billing on, no subscription: free hard-caps the month at 3 000", async () => {
    await enableBilling();
    const { checkTeamCaps, resolveTeamCaps } =
      await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    const caps = await resolveTeamCaps(team.id, NOW);
    expect(caps).toMatchObject({ monthly: 3000, source: "plan" });
    expect(caps.monthlyFrom.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    await seedEmails(team.id, 3000);
    const r = await checkTeamCaps(team.id, 1, NOW);
    expect(r).toMatchObject({ ok: false, code: "monthly_quota_exceeded" });
    if (r.ok) throw new Error("unreachable");
    expect(r.message).toContain("3,000");
    expect(r.message).toContain("Free");
  });

  it("a paid plan with overage has no monthly cap", async () => {
    await enableBilling();
    const { checkTeamCaps, resolveTeamCaps } =
      await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    await seedPlan(team.id, { overageEnabled: true });
    await seedEmails(team.id, 100);
    expect(await resolveTeamCaps(team.id, NOW)).toMatchObject({
      monthly: null,
      source: "plan",
    });
    expect(await checkTeamCaps(team.id, 1, NOW)).toEqual({ ok: true });
  });

  it("a paid plan without a metered price hard-caps at the include", async () => {
    await enableBilling();
    const { resolveTeamCaps } = await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    await seedPlan(team.id, { overageEnabled: false });
    expect(await resolveTeamCaps(team.id, NOW)).toMatchObject({
      monthly: 50000,
    });
  });

  it("a past-due plan past its grace window drops to the Free cap", async () => {
    await enableBilling();
    const { db } = await import("@/db");
    const { eq } = await import("drizzle-orm");
    const { teamBilling } = await import("@/db/schema");
    const { resolveTeamCaps } = await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    await seedPlan(team.id, { status: "past_due", overageEnabled: true });
    await db()
      .update(teamBilling)
      .set({ pastDueAt: new Date("2026-08-01T00:00:00Z") })
      .where(eq(teamBilling.teamId, team.id));
    // Inside the 7-day grace the paid (uncapped) entitlement stands...
    expect(
      await resolveTeamCaps(team.id, new Date("2026-08-05T00:00:00Z")),
    ).toMatchObject({ monthly: null, planName: "pro" });
    // ...past it, Free caps, on the calendar month.
    const after = await resolveTeamCaps(team.id, NOW);
    expect(after).toMatchObject({ monthly: 3000, planName: "free" });
    expect(after.monthlyFrom.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("team_settings always wins — the operator escape hatch", async () => {
    await enableBilling();
    const { resolveTeamCaps } = await import("@/services/send-limits");
    const { db } = await import("@/db");
    const { teamSettings } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    await seedPlan(team.id);
    await db()
      .insert(teamSettings)
      .values({ teamId: team.id, dailyLimit: 10, monthlyLimit: 100 });
    expect(await resolveTeamCaps(team.id, NOW)).toMatchObject({
      daily: 10,
      monthly: 100,
      source: "settings",
    });
  });

  it("the billing period, not the calendar month, is the monthly window", async () => {
    await enableBilling();
    const { usageSnapshot } = await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    await seedPlan(team.id, { overageEnabled: false });
    // 20 emails from before the period started must not count against it.
    await seedEmails(team.id, 20, new Date("2026-08-05T00:00:00Z"));
    await seedEmails(team.id, 7, NOW);
    const u = await usageSnapshot(team.id, NOW);
    expect(u.monthlyUsed).toBe(7);
    expect(u.monthlyFrom.toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });

  it("a stale stored period rolls forward on its own anniversary", async () => {
    await enableBilling();
    const { resolveTeamCaps } = await import("@/services/send-limits");
    const { meteringPeriodStart, billingRow } =
      await import("@/services/billing/plans");
    const { team } = await seedTeamWithKey();
    // A renewal webhook that never landed: the stored period ended in July.
    await seedPlan(team.id, {
      overageEnabled: false,
      periodStart: new Date("2026-06-10T00:00:00Z"),
      periodEnd: new Date("2026-07-10T00:00:00Z"),
    });
    // The cap window keeps the customer's anniversary rather than jumping to
    // the 1st, which would re-count sends already consumed against the
    // previous allowance and refuse a customer who has just paid.
    const caps = await resolveTeamCaps(team.id, NOW);
    expect(caps.monthlyFrom.toISOString()).toBe("2026-08-09T00:00:00.000Z");
    expect(caps.monthlyUntil.toISOString()).toBe("2026-09-08T00:00:00.000Z");
    // The metering key stays on the stored period (amendment E): the two
    // windows are deliberately different and must not be conflated.
    expect(
      meteringPeriodStart(await billingRow(team.id), NOW).toISOString(),
    ).toBe("2026-06-10T00:00:00.000Z");
  });

  it("rateHeaders reports the monthly cap when there is no daily one", async () => {
    await enableBilling();
    const { rateHeaders } = await import("@/lib/api-response");
    const { team } = await seedTeamWithKey();
    await seedEmails(team.id, 4);
    const h = await rateHeaders(team.id, NOW);
    expect(h["x-ratelimit-limit"]).toBe("3000");
    expect(h["x-ratelimit-remaining"]).toBe("2996");
    expect(h["x-ratelimit-reset"]).toBe(
      String(Math.floor(Date.UTC(2026, 8, 1) / 1000)),
    );
  });
});
