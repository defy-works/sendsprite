import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { emailEvents, emails, type EmailEventType } from "@/db/schema";

let pg: Awaited<ReturnType<typeof startPg>>;
const now = new Date("2026-08-25T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

beforeAll(async () => {
  pg = await startPg();
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now()),('org_2','Beta','beta',now())`,
  );
});
afterAll(async () => {
  await pg.stop();
});

let n = 0;
async function seedSent(
  teamId: string,
  sentAt: Date,
  outcome?: Extract<EmailEventType, "delivered" | "bounced" | "complained">,
) {
  const id = `em_${teamId}_${++n}`;
  await pg.db.insert(emails).values({
    id,
    teamId,
    from: "a@mail.acme.com",
    fromEmail: "a@mail.acme.com",
    to: ["r@x.io"],
    subject: "s",
    status: outcome ?? "sent",
    sentAt,
    createdAt: sentAt,
  });
  const rows: (typeof emailEvents.$inferInsert)[] = [
    {
      id: `evt_${id}_sent`,
      emailId: id,
      teamId,
      type: "sent",
      dedupeKey: "sent",
      occurredAt: sentAt,
    },
  ];
  if (outcome)
    rows.push({
      id: `evt_${id}_${outcome}`,
      emailId: id,
      teamId,
      type: outcome,
      dedupeKey: outcome,
      occurredAt: new Date(sentAt.getTime() + 1000),
    });
  // A duplicate delivered event must not double-count the email.
  if (outcome === "delivered")
    rows.push({
      id: `evt_${id}_dup`,
      emailId: id,
      teamId,
      type: "delivered",
      dedupeKey: "dup",
      occurredAt: new Date(sentAt.getTime() + 2000),
    });
  await pg.db.insert(emailEvents).values(rows);
}

describe("teamStats", () => {
  it("counts sends by window and computes delivery/bounce/complaint rates; no alerts under 20 sends", async () => {
    // 10 sent in the last 24h: 8 delivered, 1 bounced, 1 complained.
    for (let i = 0; i < 8; i++)
      await seedSent("org_1", hoursAgo(1), "delivered");
    await seedSent("org_1", hoursAgo(2), "bounced");
    await seedSent("org_1", hoursAgo(3), "complained");
    // Outside 24h but inside 7d / 30d; one outside 30d.
    await seedSent("org_1", hoursAgo(48), "delivered");
    await seedSent("org_1", hoursAgo(24 * 20), "bounced");
    await seedSent("org_1", hoursAgo(24 * 40), "bounced");
    // Queued (never sent) rows do not count anywhere.
    await pg.db.insert(emails).values({
      id: "em_queued",
      teamId: "org_1",
      from: "a@mail.acme.com",
      fromEmail: "a@mail.acme.com",
      to: ["r@x.io"],
      subject: "s",
    });

    const { teamStats } = await import("@/services/stats");
    const s = await teamStats("org_1", now);
    expect(s.sent).toEqual({ today: 10, d7: 11, d30: 12 });
    expect(s.rates.delivered).toBeCloseTo(9 / 12);
    expect(s.rates.bounced).toBeCloseTo(2 / 12);
    expect(s.rates.complained).toBeCloseTo(1 / 12);
    // 10 sends in 24h is under the 20-send floor: rates are shown, no alert.
    expect(s.alerts).toEqual([]);
  });

  it("raises bounce/complaint alerts at the SES thresholds once 20 sends are in the window", async () => {
    // 100 sent in the last 24h: 95 delivered, 4 bounced (4%), 1 complained (1%).
    for (let i = 0; i < 95; i++)
      await seedSent("org_2", hoursAgo(5), "delivered");
    for (let i = 0; i < 4; i++) await seedSent("org_2", hoursAgo(5), "bounced");
    await seedSent("org_2", hoursAgo(5), "complained");
    const { teamStats, instanceStats } = await import("@/services/stats");
    const s = await teamStats("org_2", now);
    expect(s.alerts).toEqual([
      { kind: "bounce", level: "warning", rate: 0.04, window: "24h" },
      { kind: "complaint", level: "critical", rate: 0.01, window: "24h" },
    ]);
    // Instance-wide: 110 sends, 5 bounced (4.5% → warning), 2 complained (1.8% → critical).
    const all = await instanceStats(now);
    expect(all.sent.today).toBe(110);
    expect(all.alerts.map((a) => [a.kind, a.level])).toEqual([
      ["bounce", "warning"],
      ["complaint", "critical"],
    ]);
  });

  it("returns zeros for a team with no sends", async () => {
    const { teamStats } = await import("@/services/stats");
    const s = await teamStats("org_none", now);
    expect(s).toEqual({
      sent: { today: 0, d7: 0, d30: 0 },
      rates: { delivered: 0, bounced: 0, complained: 0 },
      alerts: [],
    });
  });
});
