import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  CampaignCounts,
  CampaignStatus,
  EmailEventType,
  EmailStatus,
} from "@sendsprite/shared";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";
import {
  campaigns,
  contactBooks,
  contacts,
  emailEvents,
  emails,
  webhookDeliveries,
  webhooks,
} from "@/db/schema";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
});
afterAll(async () => {
  await pg.stop();
});

const stats = () => import("@/services/campaigns/stats");
const enqueue = vi.fn(async () => "job");
const deps = { enqueue };

interface Row {
  /** Defaults to `queued`, i.e. still outstanding. */
  status?: EmailStatus;
  /** `sent_at`, which only a `sent` event sets in production. */
  sentAt?: Date | null;
  events?: EmailEventType[];
  /** The contact's consent, and when it was withdrawn relative to the send. */
  unsubscribedAt?: Date | null;
}

const MAILED_AT = new Date("2026-08-26T10:00:00.000Z");

/**
 * A team with one campaign and one `emails` row per {@link Row}, each with its
 * own contact — the shape the fan-out produces, one message per person.
 *
 * Events are inserted straight into `email_events` rather than through
 * `recordEvent`, because several of these tests are about orderings
 * `recordEvent` produces but no service would let a test ask for (a
 * `delivered` that overtook its own `Send`, an email opened twice).
 */
async function seedCampaign(rows: Row[], status: CampaignStatus = "sent") {
  const suffix = randomBytes(4).toString("hex");
  const { team, actor } = await seedTeamWithKey();
  const db = pg.db;
  const bookId = `cb_${suffix}`;
  const campaignId = `cmp_${suffix}`;
  await db
    .insert(contactBooks)
    .values({ id: bookId, teamId: team.id, name: "N" });
  await db.insert(campaigns).values({
    id: campaignId,
    teamId: team.id,
    bookId,
    domainId: `dom_${suffix}`,
    name: "Launch",
    subject: "Hello",
    from: "a@mail.acme.com",
    blocks: [{ kind: "divider" }],
    status,
    sentAt: status === "sent" ? MAILED_AT : null,
  });
  const ids: string[] = [];
  for (const [i, r] of rows.entries()) {
    const contactId = `ct_${suffix}${String(i).padStart(2, "0")}`;
    const emailId = `em_${suffix}${String(i).padStart(2, "0")}`;
    await db.insert(contacts).values({
      id: contactId,
      bookId,
      teamId: team.id,
      email: `r${i}@x.io`,
      subscribed: r.unsubscribedAt === undefined,
      unsubscribedAt: r.unsubscribedAt ?? null,
    });
    await db.insert(emails).values({
      id: emailId,
      teamId: team.id,
      from: "a@mail.acme.com",
      fromEmail: "a@mail.acme.com",
      to: [`r${i}@x.io`],
      subject: "Hello",
      source: "campaign",
      campaignId,
      contactId,
      status: r.status ?? "queued",
      sentAt: r.sentAt === undefined ? MAILED_AT : r.sentAt,
      createdAt: MAILED_AT,
    });
    for (const [j, type] of (r.events ?? []).entries())
      await db.insert(emailEvents).values({
        id: `evt_${suffix}${i}${j}`,
        emailId,
        teamId: team.id,
        type,
        dedupeKey: `seed:${j}`,
      });
    ids.push(emailId);
  }
  return { team, actor, campaignId, bookId, ids, suffix, db };
}

/** An enabled endpoint subscribed to both campaign events. */
async function seedWebhook(teamId: string) {
  const id = `wh_${randomBytes(4).toString("hex")}`;
  await pg.db.insert(webhooks).values({
    id,
    teamId,
    url: "https://hooks.test/x",
    secretEnc: "enc",
    events: ["campaign.sent", "campaign.completed"],
  });
  return id;
}

const deliveries = async (teamId: string) =>
  pg.db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.teamId, teamId));

const campaignRow = async (teamId: string, id: string) =>
  (
    await pg.db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.teamId, teamId), eq(campaigns.id, id)))
  )[0]!;

const ZERO: CampaignCounts = {
  recipients: 0,
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  unsubscribed: 0,
  bounced: 0,
  complained: 0,
  failed: 0,
};

describe("campaign counts", () => {
  it("is all zero for a campaign that has materialised nothing", async () => {
    const { team, campaignId } = await seedCampaign([]);
    const { campaignCounts } = await stats();
    expect(await campaignCounts(team.id, campaignId)).toEqual(ZERO);
  });

  it("counts one row per outcome", async () => {
    const { team, campaignId } = await seedCampaign([
      { status: "delivered", events: ["sent", "delivered"] },
      { status: "bounced", events: ["sent", "bounced"] },
      { status: "complained", events: ["sent", "delivered", "complained"] },
      { status: "failed", sentAt: null, events: ["failed"] },
    ]);
    const { campaignCounts } = await stats();
    expect(await campaignCounts(team.id, campaignId)).toEqual({
      ...ZERO,
      recipients: 4,
      sent: 3,
      delivered: 2,
      bounced: 1,
      complained: 1,
      failed: 1,
    });
  });

  it("counts an email opened twice as one opener, not two opens", async () => {
    const { team, campaignId, ids } = await seedCampaign([
      {
        status: "delivered",
        events: ["sent", "delivered", "opened", "opened", "clicked", "clicked"],
      },
      { status: "delivered", events: ["sent", "delivered"] },
    ]);
    const events = await pg.db
      .select()
      .from(emailEvents)
      .where(eq(emailEvents.emailId, ids[0]!));
    // The timeline really does hold two of each: the number below is a
    // decision about what a stats page means, not an artefact of dedupe.
    expect(events.filter((e) => e.type === "opened")).toHaveLength(2);
    const { campaignCounts } = await stats();
    expect(await campaignCounts(team.id, campaignId)).toMatchObject({
      recipients: 2,
      opened: 1,
      clicked: 1,
    });
  });

  it("never reports more opens than sends, even when delivered overtook Send", async () => {
    // `sent_at` is set by the `sent` event alone, and SNS is unordered: a
    // `delivered` that arrives first leaves the row delivered with a null
    // `sent_at` for good. Counting `sent_at` alone would print
    // `delivered: 1, sent: 0` — a page a customer can see is wrong.
    const { team, campaignId } = await seedCampaign([
      {
        status: "delivered",
        sentAt: null,
        events: ["delivered", "opened", "clicked"],
      },
    ]);
    const { campaignCounts } = await stats();
    const c = await campaignCounts(team.id, campaignId);
    expect(c).toMatchObject({
      recipients: 1,
      sent: 1,
      delivered: 1,
      opened: 1,
      clicked: 1,
    });
    for (const [k, v] of Object.entries(c))
      expect(`${k}=${v}`).toBe(`${k}=${Math.min(v, c.recipients)}`);
    expect(c.opened).toBeLessThanOrEqual(c.sent);
  });

  it("attributes an unsubscribe only when it came after the send", async () => {
    const before = new Date(MAILED_AT.getTime() - 60_000);
    const after = new Date(MAILED_AT.getTime() + 60_000);
    const { team, campaignId } = await seedCampaign([
      { status: "delivered", events: ["delivered"], unsubscribedAt: after },
      { status: "delivered", events: ["delivered"], unsubscribedAt: before },
      { status: "delivered", events: ["delivered"] },
    ]);
    const { campaignCounts } = await stats();
    expect(await campaignCounts(team.id, campaignId)).toMatchObject({
      recipients: 3,
      unsubscribed: 1,
    });
  });

  it("counts only its own campaign's rows", async () => {
    const a = await seedCampaign([
      { status: "delivered", events: ["delivered"] },
    ]);
    const b = await seedCampaign([
      { status: "delivered", events: ["delivered"] },
      { status: "delivered", events: ["delivered"] },
    ]);
    const { campaignCounts } = await stats();
    expect(await campaignCounts(a.team.id, a.campaignId)).toMatchObject({
      recipients: 1,
    });
    // Another team's campaign id, asked with this team's id: nothing.
    expect(await campaignCounts(a.team.id, b.campaignId)).toEqual(ZERO);
  });

  it("refreshes the cache without touching updated_at", async () => {
    const { team, campaignId } = await seedCampaign([
      { status: "delivered", events: ["sent", "delivered"] },
    ]);
    const before = await campaignRow(team.id, campaignId);
    expect(before.counts).toEqual(ZERO);
    const { refreshCampaignCounts } = await stats();
    const counts = await refreshCampaignCounts(team.id, campaignId);
    const after = await campaignRow(team.id, campaignId);
    expect(after.counts).toEqual(counts);
    expect(after.counts).toMatchObject({ recipients: 1, delivered: 1 });
    // A count refresh is not an edit; the dashboard shows `updated_at` as
    // when someone last changed the campaign.
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});

describe("campaign.sent", () => {
  it("fires once, no matter how many callers notice the flip", async () => {
    const { team, campaignId } = await seedCampaign([
      { status: "sent", events: ["sent"] },
    ]);
    await seedWebhook(team.id);
    const { emitCampaignSent } = await stats();
    expect(await emitCampaignSent(team.id, campaignId, deps)).toBe(true);
    expect(await emitCampaignSent(team.id, campaignId, deps)).toBe(false);
    const sent = await deliveries(team.id);
    expect(sent.map((d) => d.eventType)).toEqual(["campaign.sent"]);
    expect(sent[0]!.payload).toMatchObject({
      type: "campaign.sent",
      // Wrapped under a key, like `data.email`, `data.domain`, `data.contact`.
      data: { campaign: { id: campaignId, status: "sent" } },
    });
    expect(
      (await campaignRow(team.id, campaignId)).sentNotifiedAt,
    ).toBeTruthy();
  });

  it("does not fire for a campaign that is still sending", async () => {
    const { team, campaignId } = await seedCampaign(
      [{ status: "sent", events: ["sent"] }],
      "sending",
    );
    await seedWebhook(team.id);
    const { emitCampaignSent } = await stats();
    expect(await emitCampaignSent(team.id, campaignId, deps)).toBe(false);
    expect(await deliveries(team.id)).toHaveLength(0);
  });
});

describe("campaign.completed", () => {
  it("waits while any recipient is still outstanding", async () => {
    const { team, campaignId } = await seedCampaign([
      { status: "delivered", events: ["sent", "delivered"] },
      // Accepted by SES, no outcome yet: still owed.
      { status: "sent", events: ["sent"] },
    ]);
    await seedWebhook(team.id);
    const { settleCampaign } = await stats();
    expect(await settleCampaign(team.id, campaignId, deps)).toBe(false);
    expect((await deliveries(team.id)).map((d) => d.eventType)).toEqual([
      // The catch-up `campaign.sent`, and nothing else.
      "campaign.sent",
    ]);
    expect((await campaignRow(team.id, campaignId)).completedAt).toBeNull();
  });

  it("fires exactly once when every recipient is terminal, with final counts", async () => {
    const { team, campaignId } = await seedCampaign([
      { status: "delivered", events: ["sent", "delivered", "opened"] },
      { status: "bounced", events: ["sent", "bounced"] },
    ]);
    await seedWebhook(team.id);
    const { settleCampaign } = await stats();
    expect(await settleCampaign(team.id, campaignId, deps)).toBe(true);
    expect(await settleCampaign(team.id, campaignId, deps)).toBe(false);
    const all = await deliveries(team.id);
    expect(all.map((d) => d.eventType)).toEqual([
      "campaign.sent",
      "campaign.completed",
    ]);
    const done = all.find((d) => d.eventType === "campaign.completed")!;
    expect(done.payload).toMatchObject({
      data: {
        campaign: {
          id: campaignId,
          counts: {
            recipients: 2,
            sent: 2,
            delivered: 1,
            opened: 1,
            bounced: 1,
          },
        },
      },
    });
    expect((await campaignRow(team.id, campaignId)).completedAt).toBeTruthy();
  });

  it("completes a campaign whose every send failed locally", async () => {
    // No SES event will ever arrive for these, so nothing nudges them: the
    // settle pass is the only thing that will ever notice.
    const { team, campaignId } = await seedCampaign([
      { status: "failed", sentAt: null, events: ["failed"] },
    ]);
    await seedWebhook(team.id);
    const { settleSentCampaigns } = await stats();
    // Instance-wide, like every other sweep here, so it also settles whatever
    // the tests above left behind; the second pass is the assertion that
    // matters — nothing is settled twice.
    expect(await settleSentCampaigns(deps)).toBeGreaterThanOrEqual(1);
    expect(await settleSentCampaigns(deps)).toBe(0);
    expect((await deliveries(team.id)).map((d) => d.eventType)).toEqual([
      "campaign.sent",
      "campaign.completed",
    ]);
    expect((await campaignRow(team.id, campaignId)).completedAt).toBeTruthy();
  });

  it("settles nothing for a cancelled campaign", async () => {
    const { team, campaignId } = await seedCampaign(
      [{ status: "delivered", events: ["delivered"] }],
      "cancelled",
    );
    await seedWebhook(team.id);
    const { settleCampaign, settleSentCampaigns } = await stats();
    expect(await settleCampaign(team.id, campaignId, deps)).toBe(false);
    expect(await settleSentCampaigns(deps)).toBe(0);
    expect(await deliveries(team.id)).toHaveLength(0);
  });
});

describe("the ingest nudge", () => {
  it("fires campaign.completed when the last outstanding recipient lands", async () => {
    const { team, campaignId, ids } = await seedCampaign([
      { status: "delivered", events: ["sent", "delivered"] },
      { status: "sent", events: ["sent"] },
    ]);
    await seedWebhook(team.id);
    const { ingestSesEvent } = await import("@/services/ingest");
    const res = await ingestSesEvent(
      team.id,
      {
        eventType: "Delivery",
        mail: {
          messageId: "ses-1",
          timestamp: "2026-08-26T10:05:00.000Z",
          destination: ["r1@x.io"],
          tags: { ss_email: [ids[1]!], ss_team: [team.id] },
        },
        delivery: { timestamp: "2026-08-26T10:05:00.000Z" },
      },
      `sns-${randomBytes(4).toString("hex")}`,
      deps,
    );
    expect(res).toEqual({ ok: true, recorded: true });
    expect((await deliveries(team.id)).map((d) => d.eventType)).toEqual([
      "campaign.sent",
      "campaign.completed",
    ]);
    expect((await campaignRow(team.id, campaignId)).counts).toMatchObject({
      recipients: 2,
      delivered: 2,
    });
  });

  it("leaves a non-campaign email alone", async () => {
    const { team } = await seedCampaign([]);
    await seedWebhook(team.id);
    const id = `em_plain_${randomBytes(4).toString("hex")}`;
    await pg.db.insert(emails).values({
      id,
      teamId: team.id,
      from: "a@mail.acme.com",
      fromEmail: "a@mail.acme.com",
      to: ["r@x.io"],
      subject: "s",
      status: "sent",
      sentAt: MAILED_AT,
    });
    const { ingestSesEvent } = await import("@/services/ingest");
    const res = await ingestSesEvent(
      team.id,
      {
        eventType: "Delivery",
        mail: {
          messageId: "ses-2",
          timestamp: "2026-08-26T10:05:00.000Z",
          destination: ["r@x.io"],
          tags: { ss_email: [id], ss_team: [team.id] },
        },
        delivery: { timestamp: "2026-08-26T10:05:00.000Z" },
      },
      `sns-${randomBytes(4).toString("hex")}`,
      deps,
    );
    expect(res).toEqual({ ok: true, recorded: true });
    expect(await deliveries(team.id)).toHaveLength(0);
  });
});
