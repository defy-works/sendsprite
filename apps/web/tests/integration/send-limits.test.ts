import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  // `resolveTeamCaps` reads the environment (for `BILLING_ENABLED`), so the
  // file needs a valid one even though billing stays off throughout.
  process.env.APP_URL = "http://localhost:3000";
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
  const { domains } = await import("@/db/schema");
  await pg.db.insert(domains).values({
    id: "dom_1",
    teamId: "org_1",
    name: "mail.acme.com",
    region: "eu-west-1",
    dnsMode: "manual",
    mailFromDomain: "bounce.mail.acme.com",
    status: "verified",
  });
});
afterAll(async () => {
  await pg.stop();
});

const at = (s: number) => new Date(Date.UTC(2026, 7, 25) + s * 1000);

const emailRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  teamId: "org_1",
  domainId: "dom_1",
  from: "a@mail.acme.com",
  fromEmail: "a@mail.acme.com",
  to: ["r@x.io"],
  subject: "s",
  status: "sent" as const,
  ...extra,
});

describe("send limits", () => {
  it("takeSesToken refills at MaxSendRate and refuses when empty", async () => {
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    await updateInstanceSettings(
      { sesMaxSendRate: 2, sesDailyQuota: 200 },
      undefined,
      { audit: false },
    );
    const { takeSesToken, resetRateForTests } =
      await import("@/services/send-limits");
    await resetRateForTests(at(0));
    expect(await takeSesToken(at(1))).toEqual({ ok: true }); // 2 tokens accrued, burst cap 2
    expect(await takeSesToken(at(1))).toEqual({ ok: true });
    const empty = await takeSesToken(at(1));
    expect(empty).toMatchObject({ ok: false, retryInMs: expect.any(Number) });
    if (empty.ok) throw new Error("unreachable");
    expect(empty.retryInMs).toBeGreaterThan(0);
    expect(empty.retryInMs).toBeLessThanOrEqual(500); // 1 token / 2 per s
    expect(await takeSesToken(at(2))).toEqual({ ok: true }); // refilled
    // Burst never exceeds the rate, however long the bucket sat idle.
    expect(await takeSesToken(at(60))).toEqual({ ok: true });
    expect(await takeSesToken(at(60))).toEqual({ ok: true });
    expect(await takeSesToken(at(60))).toMatchObject({ ok: false });
  });

  it("takeSesToken never rewinds the stamp for a lagging clock", async () => {
    const { takeSesToken, resetRateForTests } =
      await import("@/services/send-limits");
    await resetRateForTests(at(200));
    expect(await takeSesToken(at(201))).toEqual({ ok: true });
    expect(await takeSesToken(at(201))).toEqual({ ok: true }); // bucket empty, stamp = 201
    // A worker whose clock is behind earns nothing and must not move the stamp back...
    expect(await takeSesToken(at(200.5))).toMatchObject({ ok: false });
    // ...otherwise this taker would be credited 200.5→201.5 (2 tokens) instead of 201→201.5 (1).
    expect(await takeSesToken(at(201.5))).toEqual({ ok: true });
    expect(await takeSesToken(at(201.5))).toMatchObject({ ok: false });
  });

  it("takeSesToken serialises concurrent takers on the row lock", async () => {
    const { takeSesToken, resetRateForTests } =
      await import("@/services/send-limits");
    await resetRateForTests(at(100));
    const results = await Promise.all(
      Array.from({ length: 6 }, () => takeSesToken(at(101))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });

  it("team caps count today's/this month's non-failed emails", async () => {
    const { db } = await import("@/db");
    const { emails, teamSettings } = await import("@/db/schema");
    await db()
      .insert(teamSettings)
      .values({ teamId: "org_1", dailyLimit: 2, monthlyLimit: 3 })
      .onConflictDoUpdate({
        target: teamSettings.teamId,
        set: { dailyLimit: 2, monthlyLimit: 3, updatedAt: new Date() },
      });
    const { checkTeamCaps } = await import("@/services/send-limits");
    const now = new Date("2026-08-25T12:00:00Z");
    expect(await checkTeamCaps("org_1", 2, now)).toEqual({ ok: true });
    expect(await checkTeamCaps("org_1", 3, now)).toMatchObject({
      ok: false,
      code: "daily_quota_exceeded",
    });
    await db()
      .insert(emails)
      .values([
        emailRow("em_cap1"),
        emailRow("em_cap2"),
        // Failed/cancelled rows never count.
        emailRow("em_cap3", { status: "failed" }),
        emailRow("em_cap4", { status: "cancelled" }),
        // Earlier this month: counts against the monthly cap only.
        emailRow("em_cap5", { createdAt: new Date("2026-08-02T00:00:00Z") }),
      ]);
    expect(await checkTeamCaps("org_1", 1, now)).toMatchObject({
      ok: false,
      code: "daily_quota_exceeded",
    });
    await db()
      .update(teamSettings)
      .set({ dailyLimit: null })
      .where((await import("drizzle-orm")).eq(teamSettings.teamId, "org_1"));
    expect(await checkTeamCaps("org_1", 1, now)).toMatchObject({
      ok: false,
      code: "monthly_quota_exceeded",
    });
    // Next month starts a fresh window.
    expect(
      await checkTeamCaps("org_1", 1, new Date("2026-09-01T00:00:00Z")),
    ).toEqual({ ok: true });
    // A team without settings is uncapped.
    expect(await checkTeamCaps("org_nope", 1000, now)).toEqual({ ok: true });
  });

  it("sesDailyQuota is enforced instance-wide from sends in the last 24 h", async () => {
    const { db } = await import("@/db");
    const { emails } = await import("@/db/schema");
    const { checkInstanceQuota } = await import("@/services/send-limits");
    const now = new Date("2026-08-25T12:00:00Z");
    expect(await checkInstanceQuota(1, now)).toEqual({ ok: true });
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    await updateInstanceSettings({ sesDailyQuota: 2 }, undefined, {
      audit: false,
    });
    await db()
      .insert(emails)
      .values([
        emailRow("em_q1", { sentAt: new Date("2026-08-25T11:00:00Z") }),
        emailRow("em_q2", { sentAt: new Date("2026-08-25T11:30:00Z") }),
        // Older than 24 h: outside the SES window.
        emailRow("em_q3", { sentAt: new Date("2026-08-24T11:00:00Z") }),
      ]);
    expect(await checkInstanceQuota(1, now)).toMatchObject({
      ok: false,
      code: "daily_quota_exceeded",
    });
    // Unset quota (sandbox not yet checked) means no instance cap.
    await updateInstanceSettings({ sesDailyQuota: null }, undefined, {
      audit: false,
    });
    expect(await checkInstanceQuota(1000, now)).toEqual({ ok: true });
  });
});
