import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  EMAIL_STATUS,
  newId,
  type CampaignCounts,
  type EmailStatus,
} from "@sendsprite/shared";
import { db } from "@/db";
import { campaigns, emails } from "@/db/schema";
import { fanOutEvent } from "../webhooks";
import type { Enqueue } from "../domains";
import { getCampaign, publicCampaign } from "./crud";

/**
 * Campaign stats and the two `campaign.*` webhooks (spec §5, §8; Decision 8).
 *
 * ## Counts are derived, never incremented
 *
 * `campaigns.counts` is a **cache of {@link campaignCounts}**, not a tally
 * advanced per event. An incremented counter drifts the first time a webhook
 * retries, a worker dies mid-update, or an event arrives twice — and SES
 * delivery is explicitly at-least-once — and a stats page that disagrees with
 * the mail log is worse than one that takes an extra second to compute. So
 * every number here is a `group by` over the campaign's `emails` rows, and
 * the column is overwritten with the result rather than added to.
 *
 * ## What the nine numbers mean
 *
 * All nine are `count(*) filter (…)` over **one scan of the same row set** —
 * the campaign's `emails` rows — which is the property that makes the page
 * coherent: no count can exceed `recipients`, because every one of them
 * counts a subset of the rows `recipients` counts. `opened` and `clicked` are
 * therefore **per email, not per event**: a recipient who opens the same
 * message six times is one opener, which is what "open rate" means to
 * everyone who reads one and the only reading under which `opened / sent` is
 * a rate rather than an arbitrary ratio. The raw event count is still on the
 * message's own timeline.
 *
 * `sent` counts rows we have evidence left our hands — `sent_at`, or any
 * event that only SES could have produced. The second half of that is not
 * decoration: `sent_at` is set by the **`sent`** event alone, and SNS is
 * unordered, so a `delivered` that overtakes its own `Send` notification
 * permanently leaves a delivered row with a null `sent_at` (`recordEvent`
 * will not regress `delivered` back to `sent`). Counting `sent_at` alone
 * would then print `delivered: 1, sent: 0` on a customer's stats page —
 * visibly, unarguably wrong. Defined as evidence, `sent` is an upper bound on
 * `delivered`, `opened`, `clicked`, `bounced` and `complained` under every
 * event ordering, because each of those *is* such evidence.
 *
 * `failed` is deliberately outside that bound: a row that failed before SES
 * accepted it never left, so it is counted against `recipients` and not
 * against `sent`.
 */

/**
 * Statuses an email can no longer leave.
 *
 * Spelled out rather than derived so that adding a status later fails in the
 * safe direction: an unlisted status counts as still-pending, which delays
 * `campaign.completed` instead of firing it while recipients are outstanding.
 */
export const TERMINAL_EMAIL_STATUSES = [
  "delivered",
  "bounced",
  "complained",
  "failed",
  "cancelled",
] as const satisfies readonly EmailStatus[];

const terminal: ReadonlySet<string> = new Set(TERMINAL_EMAIL_STATUSES);

/** Everything else: a recipient whose story this campaign is still owed. */
const PENDING_EMAIL_STATUSES = EMAIL_STATUS.filter((s) => !terminal.has(s));

/**
 * Event types that only exist because SES accepted the message.
 *
 * `failed` and `rejected` are absent on purpose — see the module comment.
 */
const EVIDENCE_OF_SENDING = [
  "sent",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "opened",
  "clicked",
] as const;

/** A parameterised `in (…)` list; every value stays a bind parameter. */
const list = (xs: readonly string[]) =>
  sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );

/**
 * The nine numbers, derived. Never reads `campaigns.counts`.
 *
 * One scan of `emails_campaign_idx` with the campaign's events folded in by a
 * lateral — one index range scan of `email_events` per row, rather than the
 * six correlated `exists` subqueries `services/stats.ts` uses for the
 * overview. Same `count(*) filter` shape, and the same "count emails, not
 * events" rule that keeps a duplicate event from inflating a number; the
 * lateral is the scoped-query version of it, because this query touches every
 * row of one campaign instead of a time window of one team.
 *
 * `unsubscribed` is the one number that is not about the message. It counts
 * recipients whose consent was withdrawn **after this campaign mailed them**
 * (`unsubscribed_at >= e.created_at`, per row, not per campaign), which is
 * the honest attribution available without a column recording which mail an
 * unsubscribe came from: a contact who opted out before we mailed them is not
 * this campaign's doing, and one who opted out afterwards is attributed to
 * every campaign that mailed them in that window. Two campaigns sent the same
 * afternoon will therefore both claim the same unsubscribe.
 */
export async function campaignCounts(
  teamId: string,
  campaignId: string,
): Promise<CampaignCounts> {
  const [row] = await db().execute<Record<string, number>>(sql`
    select
      count(*)::int as recipients,
      count(*) filter (where e.sent_at is not null or ev.left_us)::int as sent,
      count(*) filter (where ev.delivered)::int as delivered,
      count(*) filter (where ev.opened)::int as opened,
      count(*) filter (where ev.clicked)::int as clicked,
      count(*) filter (
        where c.subscribed = false and c.unsubscribed_at >= e.created_at
      )::int as unsubscribed,
      count(*) filter (where ev.bounced)::int as bounced,
      count(*) filter (where ev.complained)::int as complained,
      count(*) filter (where ev.failed)::int as failed
    from emails e
    left join lateral (
      select
        bool_or(v.type in (${list(EVIDENCE_OF_SENDING)})) as left_us,
        bool_or(v.type = 'delivered') as delivered,
        bool_or(v.type = 'opened') as opened,
        bool_or(v.type = 'clicked') as clicked,
        bool_or(v.type = 'bounced') as bounced,
        bool_or(v.type = 'complained') as complained,
        bool_or(v.type in ('failed', 'rejected')) as failed
      from email_events v
      where v.email_id = e.id
    ) ev on true
    left join contacts c
      on c.id = e.contact_id and c.team_id = e.team_id
    where e.team_id = ${teamId} and e.campaign_id = ${campaignId}
  `);
  const n = (k: keyof CampaignCounts) => row?.[k] ?? 0;
  return {
    recipients: n("recipients"),
    sent: n("sent"),
    delivered: n("delivered"),
    opened: n("opened"),
    clicked: n("clicked"),
    unsubscribed: n("unsubscribed"),
    bounced: n("bounced"),
    complained: n("complained"),
    failed: n("failed"),
  };
}

/**
 * `updated_at` left where it was.
 *
 * A count refresh is not an edit of the campaign, and the dashboard shows
 * `updated_at` as when someone last changed it. Drizzle's `$onUpdate` fires
 * whenever the field is absent from `.set()`, so the only way to hold it
 * still is to name it.
 */
const keepUpdatedAt = { updatedAt: sql`${campaigns.updatedAt}` };

/**
 * Recompute the counts and overwrite the cache. Returns what it wrote.
 *
 * This is what the sweep calls as it advances a campaign, and what the
 * campaign page can call while one is still sending. Writing the cache is
 * unconditional and idempotent: it is a projection of `emails`, so the worst
 * a concurrent refresh can do is write the same answer twice.
 */
export async function refreshCampaignCounts(
  teamId: string,
  campaignId: string,
): Promise<CampaignCounts> {
  const counts = await campaignCounts(teamId, campaignId);
  await db()
    .update(campaigns)
    .set({ counts, ...keepUpdatedAt })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.teamId, teamId)));
  return counts;
}

export interface CampaignEventDeps {
  enqueue: Enqueue;
  now?: Date;
}

/**
 * Is any recipient of this campaign still owed an outcome?
 *
 * The gate that keeps completion cheap: one indexed probe that stops at the
 * first pending row instead of the full aggregate. It names `team_id` as well
 * as `campaign_id` so the planner can use `emails_team_status_idx`
 * (`team_id, status`) — a team's pending rows are few except while its own
 * campaign is in flight, which is exactly when the first match is found
 * immediately.
 */
async function hasPendingRecipient(
  teamId: string,
  campaignId: string,
): Promise<boolean> {
  const [row] = await db()
    .select({ id: emails.id })
    .from(emails)
    .where(
      and(
        eq(emails.teamId, teamId),
        eq(emails.campaignId, campaignId),
        inArray(emails.status, PENDING_EMAIL_STATUSES),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Fire `campaign.sent` — "every recipient has been queued" — exactly once.
 *
 * Not "every recipient has received it", and the docs page says so in those
 * words: an automation that treats this as delivery is wrong by the entire
 * delivery window. {@link settleCampaign} is the event for that.
 *
 * Safe to call from anywhere and as often as you like: the marker is set in
 * the same `where` that guards the fan-out, so the second caller updates no
 * rows and returns `false`. The counts are refreshed in that same statement,
 * so the payload's `counts` is the campaign as of the moment it fired rather
 * than whatever the cache last held.
 */
export async function emitCampaignSent(
  teamId: string,
  campaignId: string,
  deps: CampaignEventDeps,
): Promise<boolean> {
  const now = deps.now ?? new Date();
  const counts = await campaignCounts(teamId, campaignId);
  const [row] = await db()
    .update(campaigns)
    .set({ counts, sentNotifiedAt: now, ...keepUpdatedAt })
    .where(
      and(
        eq(campaigns.id, campaignId),
        eq(campaigns.teamId, teamId),
        // Only a campaign that finished queueing. A `sending` one has not,
        // and a `cancelled` one never will.
        eq(campaigns.status, "sent"),
        isNull(campaigns.sentNotifiedAt),
      ),
    )
    .returning();
  if (!row) return false;
  await fanOutEvent(
    teamId,
    "campaign.sent",
    newId("evt"),
    // `{ campaign: … }`, wrapped, like `data.email`, `data.domain` and
    // `data.contact`. Phase 6 changed the contact payload precisely because
    // it was fanning its fields out at the top level.
    { campaign: publicCampaign(row) },
    { enqueue: deps.enqueue, createdAt: now },
  );
  return true;
}

/**
 * Settle one campaign: fire `campaign.sent` if it is owed, then
 * `campaign.completed` if every recipient has reached a terminal state.
 *
 * Returns whether **this** call fired `campaign.completed`.
 *
 * ## Where completion is noticed, and what it costs
 *
 * "Every queued email reached a terminal state" is not an event SES sends;
 * it is a condition somebody has to look for. Looking for it with the full
 * aggregate on every inbound SES event would be one scan of a 50 000-row
 * campaign per event, so the work is staged cheapest-first and every stage
 * short-circuits:
 *
 * 1. one indexed read of the campaign row — anything not `sent` owes nothing;
 * 2. `completed_at` already set — done, and this is the steady state after a
 *    campaign finishes, so late events cost one indexed read and nothing more;
 * 3. {@link hasPendingRecipient} — one indexed probe that stops at the first
 *    outstanding recipient;
 * 4. only then the aggregate, which therefore runs at most twice in a
 *    campaign's life: once for `campaign.sent`, once here.
 *
 * So a terminal SES event for a campaign message costs two indexed lookups,
 * and the expensive query happens once.
 *
 * **Exactly once** is the conditional UPDATE, not the ordering of the checks
 * above: two workers can both see the same "nothing pending" and only the one
 * that stamps `completed_at` fans anything out. Firing twice is worse than
 * firing late, and this fires late by design — the condition is re-checked
 * rather than trusted.
 *
 * A `cancelled` campaign settles neither event: it never finished queueing,
 * so there is no "every recipient" to be done with. Nor does a campaign whose
 * rows are stuck in `sent` because SES never reported an outcome — recorded
 * as an opener rather than papered over with a timeout, because a campaign
 * that silently "completes" with half its deliveries unknown is the worse
 * failure.
 */
export async function settleCampaign(
  teamId: string,
  campaignId: string,
  deps: CampaignEventDeps,
): Promise<boolean> {
  const campaign = await getCampaign(teamId, campaignId);
  if (!campaign || campaign.status !== "sent") return false;
  // Catch-up, not the normal path: the sweep fires this at the flip. It
  // matters when nothing did — a worker that died between the flip and the
  // fan-out would otherwise owe a `campaign.sent` nobody ever sends.
  if (!campaign.sentNotifiedAt)
    await emitCampaignSent(teamId, campaignId, deps);
  if (campaign.completedAt) return false;
  if (await hasPendingRecipient(teamId, campaignId)) return false;
  const now = deps.now ?? new Date();
  const counts = await campaignCounts(teamId, campaignId);
  const [row] = await db()
    .update(campaigns)
    .set({ counts, completedAt: now, ...keepUpdatedAt })
    .where(
      and(
        eq(campaigns.id, campaignId),
        eq(campaigns.teamId, teamId),
        eq(campaigns.status, "sent"),
        isNull(campaigns.completedAt),
      ),
    )
    .returning();
  if (!row) return false;
  await fanOutEvent(
    teamId,
    "campaign.completed",
    newId("evt"),
    { campaign: publicCampaign(row) },
    { enqueue: deps.enqueue, createdAt: now },
  );
  return true;
}

/** Campaigns a settle pass will look at in one tick. */
const SETTLE_BATCH = 20;

/**
 * The backstop: settle every campaign that has finished queueing and not yet
 * completed, oldest first. Returns how many completed on this pass.
 *
 * A cron pass rather than only the ingest nudge, because the last recipient
 * to reach a terminal state does not always do so through an inbound SES
 * event: a send that fails locally never produces one, and a campaign whose
 * every recipient failed that way produces none at all. Bounded per tick for
 * the reason the fan-out sweep is bounded — one enormous backlog must not
 * starve the others or give a tick an unpredictable ceiling.
 */
export async function settleSentCampaigns(
  deps: CampaignEventDeps,
  limit = SETTLE_BATCH,
): Promise<number> {
  const due = await db()
    .select({ id: campaigns.id, teamId: campaigns.teamId })
    .from(campaigns)
    .where(and(eq(campaigns.status, "sent"), isNull(campaigns.completedAt)))
    .orderBy(asc(campaigns.sentAt))
    .limit(limit);
  let completed = 0;
  for (const c of due)
    if (await settleCampaign(c.teamId, c.id, deps)) completed++;
  return completed;
}
