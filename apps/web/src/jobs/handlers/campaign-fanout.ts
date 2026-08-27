import { and, asc, eq, lte, sql } from "drizzle-orm";
import { registerQueue } from "../boss";
import { enqueue } from "../enqueue";
import { Q } from "../queues";
import { db } from "@/db";
import { campaigns } from "@/db/schema";
import { fanoutChunk, startCampaign } from "@/services/campaigns/fanout";
import {
  emitCampaignSent,
  refreshCampaignCounts,
  settleSentCampaigns,
} from "@/services/campaigns/stats";
import type { Enqueue } from "@/services/domains";

/**
 * The three crons that drive a campaign from `scheduled` to `completed`.
 *
 * ## Nothing here enqueues itself
 *
 * A handler on an exclusive queue that re-enqueues itself has silently
 * stalled this codebase twice (`domain-verify.ts` and `webhook-deliver.ts`
 * both carry the scar), and the rule that came out of it is absolute:
 * continuation is a cron, never a job that schedules its own successor. So
 * each campaign gets **one bounded chunk per tick** and the next tick does
 * the next one. A 50 000-recipient campaign takes 100 ticks at `CHUNK = 500`
 * — an hour and forty minutes of *materialising*, which is not the same thing
 * as an hour and forty minutes of sending, because delivery rate is governed
 * downstream by the SES token bucket and not by this file. If a campaign
 * needs to materialise faster, raise `CHUNK`; there is no version of this
 * that recurses.
 *
 * ## Every sweep is bounded at both ends
 *
 * Per campaign by `CHUNK`, and per tick by {@link SWEEP_BATCH}. Without the
 * second bound one enormous campaign would decide how long a tick takes, and
 * a tick that overruns its own cron interval is how a queue becomes a
 * backlog. With it a tick costs at most ten chunks whatever is in flight, and
 * campaigns are taken oldest-first so the one that has been waiting longest
 * is never the one that gets dropped.
 *
 * ## No module-scope work
 *
 * `handlers/index.ts` imports every handler module, and a module that throws
 * at import time takes the whole worker down with it (recorded as a Phase 7
 * opener). Everything below is a `registerQueue` call and a function
 * declaration.
 */

/**
 * Campaigns one tick will look at, in each sweep.
 *
 * Ten rather than "all of them" so a tick has a predictable ceiling: ten
 * chunks of at most 500 recipients, plus one count refresh each. The tail is
 * not dropped, only deferred to the next minute — with one exception worth
 * knowing about: a campaign that is paused (a send cap it will not clear
 * until the billing month rolls over, a domain nobody re-verifies) stays
 * `sending` and keeps its slot in the oldest-first ordering for as long as it
 * is paused. Eleven such campaigns would starve a twelfth. Bounded work and
 * fair scheduling are two different problems and this only solves the first;
 * the second is a Phase 8 opener, and the honest reason it is not solved here
 * is that it needs state (a "last attempted" column) that does not exist yet.
 */
export const SWEEP_BATCH = 10;

export interface FanoutSweepSummary {
  /** Campaigns this tick asked for a chunk. */
  campaigns: number;
  /** Recipients materialised across all of them. */
  materialised: number;
  /** Campaigns this tick finished queueing (`sending` → `sent`). */
  completed: number;
  /** Campaigns a cap or an unverified domain stopped this tick. */
  paused: number;
}

/**
 * Cron: flip every `scheduled` campaign whose time has come to `sending`.
 *
 * Oldest `scheduled_at` first, at most {@link SWEEP_BATCH} per tick, served
 * by `campaigns_status_idx (status, scheduled_at)`. A campaign with no
 * `scheduled_at` is not due by definition and the comparison excludes it.
 *
 * One campaign's failure must not cost the others their tick: the queue is
 * registered with `retryLimit: 0`, so an exception here is not retried, it is
 * simply the next minute's problem — and a campaign that throws every time
 * would otherwise permanently shadow every campaign behind it in the
 * ordering. Exported so tests can drive it directly. Returns how many
 * campaigns this call started.
 */
export async function startDueCampaigns(
  opts: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const due = await db()
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(eq(campaigns.status, "scheduled"), lte(campaigns.scheduledAt, now)),
    )
    .orderBy(asc(campaigns.scheduledAt))
    .limit(opts.limit ?? SWEEP_BATCH);
  let started = 0;
  for (const c of due) {
    try {
      if ((await startCampaign(c.id, { now })).started) started++;
    } catch (e) {
      console.error(`[campaigns] start failed for ${c.id}:`, e);
    }
  }
  return started;
}

/**
 * Cron: advance every campaign in `sending` by exactly one chunk.
 *
 * Oldest `started_at` first — nulls first, because a campaign that reached
 * `sending` without a `started_at` (a direct write, a fixture) has no claim
 * to be later than one that has one, and sorting it last would let it starve
 * behind a long queue of stamped campaigns.
 *
 * ## The once-only completion work lives here, not in the fan-out
 *
 * `fanoutChunk` returns `completed: true` on the single call that flips
 * `sending` → `sent`, and this is where that edge is consumed. Deriving the
 * same thing from `done` would re-fire the `campaign.sent` webhook on every
 * subsequent tick, because `done` is a level (the campaign owes no more
 * chunks) and completion is an edge (this call is the one that finished it).
 *
 * Even so, the edge is not what makes `campaign.sent` fire once — a lost
 * tick, two workers, or the ingest path noticing the same condition would all
 * break an edge-based guarantee. {@link emitCampaignSent} stamps
 * `sent_notified_at` in the same conditional UPDATE that fans the event out,
 * so the second caller updates no rows and stays silent. The edge is an
 * optimisation on top of that: it keeps a finished campaign from re-running
 * the aggregate every minute for the rest of its life.
 *
 * Exported so tests can drive it directly.
 */
export async function sweepSendingCampaigns(deps: {
  enqueue: Enqueue;
  now?: Date;
  limit?: number;
}): Promise<FanoutSweepSummary> {
  const now = deps.now ?? new Date();
  const due = await db()
    .select({ id: campaigns.id, teamId: campaigns.teamId })
    .from(campaigns)
    .where(eq(campaigns.status, "sending"))
    .orderBy(sql`${campaigns.startedAt} asc nulls first`)
    .limit(deps.limit ?? SWEEP_BATCH);

  const summary: FanoutSweepSummary = {
    campaigns: due.length,
    materialised: 0,
    completed: 0,
    paused: 0,
  };
  for (const c of due) {
    try {
      const res = await fanoutChunk(c.id, { enqueue: deps.enqueue, now });
      summary.materialised += res.materialised;
      if (res.paused) summary.paused++;
      if (res.completed) {
        summary.completed++;
        // `campaign.sent`, and with it the count cache: `emitCampaignSent`
        // recomputes the counts inside its own guarded UPDATE, so the payload
        // carries the campaign as it was when the event fired. The refresh
        // below is therefore only the losing branch — if this call did not
        // fire the event, whoever did has already written the counts, and the
        // only way to get here having written neither is a campaign that
        // moved out of `sent` underneath us.
        if (!(await emitCampaignSent(c.teamId, c.id, { ...deps, now })))
          await refreshCampaignCounts(c.teamId, c.id);
      } else if (res.materialised + res.skipped > 0) {
        // Decision 8: the sweep that advances a campaign refreshes its count
        // cache, so a campaign still sending has live numbers on the
        // dashboard without the page having to recompute them.
        //
        // Only on a tick that moved: a paused campaign is asked again every
        // minute for potentially the rest of a billing month, and re-deriving
        // nine counts over 50 000 rows to write the same answer would be the
        // one part of a paused tick that is not free. Nothing else in this
        // branch is noisy either — the audit row and the log line are
        // de-duplicated per reason inside the fan-out.
        await refreshCampaignCounts(c.teamId, c.id);
      }
    } catch (e) {
      // Deliberately swallowed per campaign: with `retryLimit: 0` a throw
      // here would abandon every campaign after this one in the batch, and
      // one campaign in a bad state must not stop the rest of the tenancy
      // sending.
      console.error(`[campaigns] fan-out failed for ${c.id}:`, e);
    }
  }
  if (summary.materialised || summary.completed)
    console.info(
      `[campaigns] materialised ${summary.materialised} recipient(s) across ${summary.campaigns} campaign(s); ${summary.completed} finished queueing`,
    );
  return summary;
}

/**
 * Flips `scheduled` campaigns whose time has come to `sending`: renders the
 * body once, stores it, re-checks the domain, and lets the fan-out sweep take
 * over. Every minute.
 */
registerQueue(Q.campaignStartSweep, () => startDueCampaigns(), {
  cron: "* * * * *",
  // retryLimit 0: a failed tick is simply retried by the next one, and
  // starting is idempotent (the status flip is a conditional update).
  queue: { retryLimit: 0 },
});

/**
 * Advances every campaign in `sending` by one chunk. Every minute.
 *
 * One chunk per campaign per tick, deliberately: a 50 000-recipient campaign
 * takes 100 ticks at CHUNK=500 rather than monopolising the worker, and a
 * second campaign starting mid-way still makes progress on the next tick.
 * Throughput is governed by the SES token bucket downstream, not here.
 */
registerQueue(Q.campaignFanoutSweep, () => sweepSendingCampaigns({ enqueue }), {
  cron: "* * * * *",
  queue: { retryLimit: 0 },
});

/**
 * Fires `campaign.completed` for campaigns whose every recipient has reached
 * a terminal state. Every minute.
 *
 * The ingest path already nudges a campaign when a terminal SES event arrives
 * for one of its messages, and that is the fast path. This is the one that
 * makes the event reliable rather than merely usual: a send that fails
 * *locally* — no verified domain at send time, an SES call that never
 * succeeded, a row cancelled by retention — produces no inbound event at all,
 * so a campaign whose every recipient failed that way would sit `sent` for
 * ever and never fire the event a customer's automation is waiting on.
 */
registerQueue(Q.campaignSettleSweep, () => settleSentCampaigns({ enqueue }), {
  cron: "* * * * *",
  queue: { retryLimit: 0 },
});
