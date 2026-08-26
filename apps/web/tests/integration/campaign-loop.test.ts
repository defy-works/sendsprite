import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLog,
  campaigns,
  contactBooks,
  contacts,
  domains,
  emails,
  webhookDeliveries,
  webhooks,
} from "@/db/schema";
import { Q } from "@/jobs/queues";
import { startPg, type TestPg } from "./_pg";
import { connectTeamAws, seedTeamWithKey } from "./helpers";

/**
 * The campaign loop through a real pg-boss: the sweeps are attached to their
 * queues, and a campaign is driven `scheduled` → `sending` → `sent` by
 * separate ticks, one bounded chunk each.
 *
 * This is the regression test for the shape the phase is not allowed to have.
 * Two handlers in this codebase have stalled by enqueueing themselves onto
 * their own exclusive queue, and the fan-out is the third place the
 * temptation appears — so what is asserted here is that **progress comes from
 * the next tick and from nothing else**: every step below is one job sent to
 * one sweep queue, and the campaign advances by exactly the work that tick
 * owes.
 *
 * ## Why the crons are unscheduled
 *
 * `startWorker()` schedules all three sweeps at `* * * * *`, and a test file
 * that takes 40 s would otherwise get a free tick in the middle of it. That
 * is fine for a convergence assertion and fatal for "a cancel between ticks
 * stops the fan-out", which is about what happens in the gap. So the
 * schedules are removed and every tick in this file is explicit — the queues,
 * the handlers and the registration are all still the real ones.
 */

const APP_URL = "https://mail.loop.test";
const ses = mockClient(SESv2Client);
let pg: TestPg;

/**
 * 60 s, not 30: `domain-loop.test.ts` records a shared CI runner reaching its
 * first step at 32.8 s — a flake that failed a tag build and passed on
 * re-run. This file waits on the same real worker polling the same real
 * queues, so it gets the same patience. A genuinely stuck loop still reports
 * which step it did not reach, because the project's vitest timeout is 120 s.
 */
async function until<T>(
  what: string,
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  ms = 60_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline)
      throw new Error(`${what} not reached in ${ms}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * One sweep tick, run by the worker, awaited to completion.
 *
 * Sending the job rather than calling the exported function is the point: it
 * goes through the queue the handler is registered on, so a sweep that was
 * never attached (or a module that threw on import and took the worker's
 * handler registry with it) fails here rather than passing silently.
 */
async function tick(queue: string): Promise<void> {
  const { getBoss } = await import("@/jobs/boss");
  const b = await getBoss();
  const id = await b.send(queue, {});
  if (!id) throw new Error(`${queue}: send returned no job id`);
  const job = await until(
    `${queue} tick`,
    () => b.getJobById<object>(queue, id),
    // Archived out from under us counts as finished; the assertions that
    // follow are about the campaign, not the job row.
    (j) => !j || j.state === "completed" || j.state === "failed",
  );
  if (job?.state === "failed")
    throw new Error(`${queue} tick failed: ${JSON.stringify(job.output)}`);
}

interface SeedOpts {
  /** Contacts in the book, all subscribed and eligible. */
  contacts?: number;
  status?: "draft" | "scheduled" | "sending";
  /** Defaults to a minute ago, i.e. due. */
  scheduledAt?: Date | null;
  domainStatus?: "verified" | "pending";
  /** Store the render, as the start sweep does. Needed to seed `sending`. */
  render?: boolean;
}

const BLOCKS = [
  { kind: "text", html: "Hello <strong>there</strong>" },
  { kind: "divider" },
];

/**
 * A team with a verified domain, a book and one campaign, written straight to
 * the tables. Contact ids are `ct_<suffix><nn>` so lexicographic order — the
 * order `selectEligible` walks — is the seed order.
 */
async function seed({
  contacts: want = 3,
  status = "scheduled",
  scheduledAt = new Date(Date.now() - 60_000),
  domainStatus = "verified",
  render = status === "sending",
}: SeedOpts = {}) {
  const { team } = await seedTeamWithKey();
  // Every seed() makes a fresh team, and each team sends through its own AWS
  // account now — so the connection is made here, not once in beforeAll.
  await connectTeamAws(team.id, {
    region: "eu-west-1",
    configSet: "sendsprite",
    // The default (1/s) would spend most of this file's wall clock waiting
    // for send tokens for mail no assertion looks at.
    sesMaxSendRate: 50,
  });
  const suffix = randomBytes(4).toString("hex");
  const domainName = `${suffix}.loop.test`;
  const domainId = `dom_${suffix}`;
  const bookId = `cb_${suffix}`;
  const campaignId = `cmp_${suffix}`;
  await pg.db.insert(domains).values({
    id: domainId,
    teamId: team.id,
    name: domainName,
    region: "eu-west-1",
    dnsMode: "manual",
    status: domainStatus,
    mailFromDomain: `bounce.${domainName}`,
  });
  await pg.db
    .insert(contactBooks)
    .values({ id: bookId, teamId: team.id, name: "News" });
  const ids = Array.from(
    { length: want },
    (_, i) => `ct_${suffix}${String(i).padStart(2, "0")}`,
  );
  if (ids.length)
    await pg.db.insert(contacts).values(
      ids.map((id, i) => ({
        id,
        bookId,
        teamId: team.id,
        email: `r${i}@rcpt.test`,
        subscribed: true,
      })),
    );
  const { renderBlocks } = await import("@sendsprite/shared");
  const rendered = render ? renderBlocks(BLOCKS as never) : null;
  await pg.db.insert(campaigns).values({
    id: campaignId,
    teamId: team.id,
    bookId,
    domainId,
    name: "August news",
    subject: "Hello",
    from: `news@${domainName}`,
    blocks: BLOCKS as never,
    html: rendered?.html ?? null,
    text: rendered?.text ?? null,
    status,
    scheduledAt,
    startedAt: status === "sending" ? new Date() : null,
  });
  // Every campaign event, so "fired exactly once" is observable as rows.
  await pg.db.insert(webhooks).values({
    id: `wh_${suffix}`,
    teamId: team.id,
    url: "https://hooks.loop.test/x",
    secretEnc: "enc",
    events: ["campaign.sent", "campaign.completed"],
  });
  return { team, suffix, domainId, domainName, bookId, campaignId, ids };
}

const campaignRow = async (id: string) =>
  (await pg.db.select().from(campaigns).where(eq(campaigns.id, id)))[0]!;

const emailCount = async (campaignId: string) =>
  (
    await pg.db
      .select({ n: sql<number>`count(*)::int` })
      .from(emails)
      .where(eq(emails.campaignId, campaignId))
  )[0]!.n;

const pauseAudits = async (campaignId: string) =>
  pg.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetId, campaignId),
        eq(auditLog.action, "campaigns.paused"),
      ),
    );

const campaignEvents = async (teamId: string) =>
  (
    await pg.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.teamId, teamId))
  ).map((d) => d.eventType);

beforeAll(async () => {
  process.env.APP_URL = APP_URL;
  process.env.APP_SECRET = "l".repeat(48);
  delete process.env.AWS_E2E_MOCK;
  pg = await startPg();
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
  // The fan-out enqueues real `email.send` jobs and the worker runs them;
  // SES is mocked so those sends succeed quietly instead of throwing an
  // unconfigured-account error a minute at a time.
  // A *different* message id per call: `emails.ses_message_id` is unique, so
  // a fixed one lets exactly one send in the file succeed and reverts every
  // other row to `queued` on a constraint violation.
  ses.on(SendEmailCommand).callsFake(() => ({
    MessageId: `ses-${randomBytes(8).toString("hex")}`,
  }));

  const { startWorker, getBoss } = await import("@/jobs/boss");
  await startWorker();
  const b = await getBoss();
  // See the file comment: every tick here is explicit.
  for (const q of [
    Q.campaignStartSweep,
    Q.campaignFanoutSweep,
    Q.campaignSettleSweep,
  ])
    await b.unschedule(q);
});

afterAll(async () => {
  const { stopWorker } = await import("@/jobs/boss");
  await stopWorker();
  await pg.stop();
});

describe("the campaign sweeps through pg-boss", () => {
  it("drives a campaign from scheduled to sent across ticks", async () => {
    const { team, campaignId, ids } = await seed({ contacts: 3 });

    // Tick 1 — the start sweep. Renders once, stores the render, stamps
    // `startedAt`, and mails nobody.
    await tick(Q.campaignStartSweep);
    const started = await campaignRow(campaignId);
    expect(started.status).toBe("sending");
    expect(started.startedAt).toBeInstanceOf(Date);
    expect(started.html).toContain("Hello <strong>there</strong>");
    expect(started.text).toBeTruthy();
    expect(await emailCount(campaignId)).toBe(0);

    // Tick 2 — one chunk. The whole audience fits in one, but a short chunk
    // must not finish the campaign: only an empty select proves the book is
    // walked out.
    await tick(Q.campaignFanoutSweep);
    expect(await emailCount(campaignId)).toBe(3);
    const sending = await campaignRow(campaignId);
    expect(sending.status).toBe("sending");
    expect(sending.fanoutCursor).toBe(ids[2]);
    expect(sending.sentAt).toBeNull();
    // Decision 8: the sweep refreshes the count cache as it advances.
    expect(sending.counts.recipients).toBe(3);

    // Tick 3 — nothing left, so this is the tick that finishes it, and the
    // once-only completion work happens here rather than inside the fan-out.
    await tick(Q.campaignFanoutSweep);
    const sent = await campaignRow(campaignId);
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).toBeInstanceOf(Date);
    expect(sent.sentNotifiedAt).toBeInstanceOf(Date);
    expect(await campaignEvents(team.id)).toEqual(["campaign.sent"]);
    expect(await emailCount(campaignId)).toBe(3);
  });

  /*
   * The `campaign.sent` webhook is the one event in the phase that cannot be
   * allowed to repeat: a customer's automation treats it as "the send is
   * away". `done` is a level and would re-fire it every minute for ever;
   * `completed` is the edge, and `sent_notified_at` is the guarantee.
   */
  it("fires campaign.sent exactly once however many ticks follow", async () => {
    const { team, campaignId } = await seed({ contacts: 2 });
    await tick(Q.campaignStartSweep);
    await tick(Q.campaignFanoutSweep);
    await tick(Q.campaignFanoutSweep);
    const finished = await campaignRow(campaignId);
    expect(finished.status).toBe("sent");
    const notifiedAt = finished.sentNotifiedAt!;
    expect(await campaignEvents(team.id)).toEqual(["campaign.sent"]);

    for (let i = 0; i < 3; i++) await tick(Q.campaignFanoutSweep);

    expect(await campaignEvents(team.id)).toEqual(["campaign.sent"]);
    expect((await campaignRow(campaignId)).sentNotifiedAt).toEqual(notifiedAt);
    expect(await emailCount(campaignId)).toBe(2);
  });

  /*
   * A cancel lands between ticks — the only place it can land, since the
   * fan-out re-asserts `sending` under a row lock inside its own transaction.
   * The contact added after the cancel is what makes this a real assertion:
   * it sorts after the cursor, so a sweep that still touched this campaign
   * would mail it.
   */
  it("a cancel between ticks stops the fan-out", async () => {
    const { campaignId, bookId, team, suffix } = await seed({ contacts: 2 });
    await tick(Q.campaignStartSweep);
    await tick(Q.campaignFanoutSweep);
    expect(await emailCount(campaignId)).toBe(2);

    await pg.db
      .update(campaigns)
      .set({ status: "cancelled" })
      .where(eq(campaigns.id, campaignId));
    await pg.db.insert(contacts).values({
      id: `ct_${suffix}99`,
      bookId,
      teamId: team.id,
      email: "late@rcpt.test",
      subscribed: true,
    });

    await tick(Q.campaignFanoutSweep);
    await tick(Q.campaignFanoutSweep);

    const row = await campaignRow(campaignId);
    expect(row.status).toBe("cancelled");
    expect(row.sentAt).toBeNull();
    expect(await emailCount(campaignId)).toBe(2);
    // A cancelled campaign never finished queueing, so neither event is owed.
    expect(await campaignEvents(team.id)).toEqual([]);
  });

  /*
   * `crud.ts` proves the domain is verified when a campaign is authored, and
   * `campaigns.domain_id` carries no foreign key, so nothing re-asserts it
   * afterwards — a campaign scheduled for Thursday can be sent from a domain
   * that stopped verifying on Wednesday.
   */
  it("does not start a campaign whose domain stopped being verified", async () => {
    const { campaignId, domainId } = await seed({
      contacts: 2,
      domainStatus: "pending",
    });

    await tick(Q.campaignStartSweep);
    await tick(Q.campaignStartSweep);

    const held = await campaignRow(campaignId);
    // Left `scheduled` — which is still editable, where `cancelled` is not —
    // and nothing rendered, nothing mailed.
    expect(held.status).toBe("scheduled");
    expect(held.startedAt).toBeNull();
    expect(held.html).toBeNull();
    expect(await emailCount(campaignId)).toBe(0);
    // Recorded once for a reason somebody can look up, and *once* however
    // many ticks ask: this campaign is reconsidered every minute until
    // somebody fixes the domain.
    const audits = await pauseAudits(campaignId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.diff).toMatchObject({
      reason: { to: "domain_not_verified" },
    });

    // And it is a pause, not a stop: verifying the domain lets the very next
    // tick start the campaign, with no intervention from the customer.
    await pg.db
      .update(domains)
      .set({ status: "verified" })
      .where(eq(domains.id, domainId));
    await tick(Q.campaignStartSweep);
    expect((await campaignRow(campaignId)).status).toBe("sending");
  });

  /*
   * The same fact arriving mid-send, which is the expensive version: without
   * this the fan-out goes on stamping a dead domain id onto rows SES then
   * rejects one at a time — and, because `emails.domain_id` *does* have a
   * foreign key, a *deleted* domain fails the whole chunk's insert instead,
   * every minute, for ever.
   */
  it("pauses a sending campaign whose domain was deleted, and resumes when it is verified again", async () => {
    const { campaignId, domainId, domainName, team } = await seed({
      contacts: 2,
      status: "sending",
    });
    await pg.db.delete(domains).where(eq(domains.id, domainId));

    await tick(Q.campaignFanoutSweep);
    await tick(Q.campaignFanoutSweep);

    const paused = await campaignRow(campaignId);
    // Still `sending`, cursor untouched, nobody mailed and nobody rejected.
    expect(paused.status).toBe("sending");
    expect(paused.fanoutCursor).toBeNull();
    expect(await emailCount(campaignId)).toBe(0);
    const audits = await pauseAudits(campaignId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.diff).toMatchObject({
      reason: { to: "domain_not_verified" },
    });

    // Re-adding the domain mints a *new* id, which is exactly why the check
    // asks "is there a verified domain for this address?" rather than "is
    // this id still verified?" — an id-based check could never be satisfied
    // again, and the campaign could never be resumed.
    const revived = `dom_${randomBytes(4).toString("hex")}`;
    await pg.db.insert(domains).values({
      id: revived,
      teamId: team.id,
      name: domainName,
      region: "eu-west-1",
      dnsMode: "manual",
      status: "verified",
      mailFromDomain: `bounce.${domainName}`,
    });

    await tick(Q.campaignFanoutSweep);
    expect(await emailCount(campaignId)).toBe(2);
    // The rows carry the domain that will actually send them, not the dead
    // one the campaign still names.
    const rows = await pg.db
      .select()
      .from(emails)
      .where(eq(emails.campaignId, campaignId));
    expect(rows.map((r) => r.domainId)).toEqual([revived, revived]);

    await tick(Q.campaignFanoutSweep);
    expect((await campaignRow(campaignId)).status).toBe("sent");
  });

  /*
   * The settle cron, and the case that makes it necessary rather than merely
   * tidy: the ingest nudge only fires when an SES event arrives, so a
   * campaign whose recipients all reached a terminal state without one would
   * never fire `campaign.completed` at all.
   */
  it("the settle sweep completes a campaign whose recipients are all terminal", async () => {
    const { team, campaignId } = await seed({ contacts: 2 });
    await tick(Q.campaignStartSweep);
    await tick(Q.campaignFanoutSweep);
    await tick(Q.campaignFanoutSweep);
    expect((await campaignRow(campaignId)).status).toBe("sent");

    // No SES event will ever arrive for these — but the worker is still
    // sending them, and a row it claims after this update would be pending
    // again. Wait until every row has left the send path first.
    const rows = () =>
      pg.db.select().from(emails).where(eq(emails.campaignId, campaignId));
    await until(
      "every send attempted",
      rows,
      (rs) =>
        rs.length === 2 &&
        rs.every((r) => !["queued", "scheduled", "sending"].includes(r.status)),
    );
    await pg.db
      .update(emails)
      .set({ status: "failed" })
      .where(eq(emails.campaignId, campaignId));

    await tick(Q.campaignSettleSweep);
    await tick(Q.campaignSettleSweep);

    expect((await campaignRow(campaignId)).completedAt).toBeInstanceOf(Date);
    expect(await campaignEvents(team.id)).toEqual([
      "campaign.sent",
      "campaign.completed",
    ]);
  });
});

/*
 * The sweep's own bound. One enormous campaign must not decide how long a
 * tick takes, and a tick must have a predictable ceiling — so the batch is
 * asserted directly rather than through the queue, which is the one thing
 * here that is about arithmetic instead of about the loop.
 */
describe("the fan-out sweep's per-tick bound", () => {
  it("takes at most SWEEP_BATCH campaigns per tick, oldest first", async () => {
    const { sweepSendingCampaigns, SWEEP_BATCH } =
      await import("@/jobs/handlers/campaign-fanout");
    const { team } = await seedTeamWithKey();
    const suffix = randomBytes(4).toString("hex");
    const bookId = `cb_${suffix}`;
    await pg.db
      .insert(contactBooks)
      .values({ id: bookId, teamId: team.id, name: "Empty" });
    const t0 = Date.now();
    const ids = Array.from(
      { length: SWEEP_BATCH + 1 },
      (_, i) => `cmp_${suffix}${String(i).padStart(2, "0")}`,
    );
    await pg.db.insert(campaigns).values(
      ids.map((id, i) => ({
        id,
        teamId: team.id,
        bookId,
        domainId: `dom_${suffix}`,
        name: `C${i}`,
        subject: "Hi",
        from: `news@${suffix}.loop.test`,
        blocks: BLOCKS as never,
        html: "<p>x</p>",
        text: "x",
        status: "sending" as const,
        // An hour back, so these are unambiguously the oldest `sending`
        // campaigns in the database and no campaign an earlier test left
        // behind can take one of the batch's ten slots. Newest first in
        // insertion order, so "oldest first" is the reverse of the id order
        // and cannot be satisfied by accident.
        startedAt: new Date(t0 - 3_600_000 - i * 1000),
      })),
    );

    const enqueued: string[] = [];
    const summary = await sweepSendingCampaigns({
      enqueue: async (queue) => {
        enqueued.push(queue);
        return "job";
      },
    });

    expect(summary.campaigns).toBe(SWEEP_BATCH);
    // An empty book finishes a campaign on its first tick, so exactly the
    // batch's worth completed — and the one left over is the *newest*.
    expect(summary.completed).toBe(SWEEP_BATCH);
    const remaining = await pg.db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(
        and(eq(campaigns.teamId, team.id), eq(campaigns.status, "sending")),
      );
    expect(remaining.map((r) => r.id)).toEqual([ids[0]]);
    // Nothing was materialised, so nothing was enqueued — and in particular
    // the sweep did not enqueue itself.
    expect(enqueued).toEqual([]);
  });
});
