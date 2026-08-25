import {
  and,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  max,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  billingUsage,
  emails,
  teamBilling,
  type BillingUsage,
} from "@/db/schema";
import { meteringPeriodStart, type UsageWindow } from "./plans";
import type { BillingProvider, UsageEvent } from "./provider";

/**
 * Statuses that consumed a send. Identical to `ACTIVE` in
 * `services/send-limits.ts` on purpose: the meter and the caps must count the
 * same rows, or a customer gets billed for sends a cap refused.
 */
export const BILLABLE = [
  "queued",
  "scheduled",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "complained",
] as const;

/** Emails a team created in `[w.start, w.end)` that count towards usage. */
export async function countSentIn(
  teamId: string,
  w: UsageWindow,
): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(emails)
    .where(
      and(
        eq(emails.teamId, teamId),
        gte(emails.createdAt, w.start),
        lt(emails.createdAt, w.end),
        inArray(emails.status, [...BILLABLE]),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * The metering watermark for a team's period, if one has been written.
 * `periodStart` is the **stored** `team_billing.period_start` — see
 * `meteringPeriodStart` in `./plans` for why it is never the entitlement's.
 */
export async function usageRow(
  teamId: string,
  periodStart: Date,
): Promise<BillingUsage | undefined> {
  const [row] = await db()
    .select()
    .from(billingUsage)
    .where(
      and(
        eq(billingUsage.teamId, teamId),
        eq(billingUsage.periodStart, periodStart),
      ),
    );
  return row;
}

/**
 * How far this team has been reported *at all*, across every period.
 *
 * The watermark is a per-team fact, not a per-period one, because bucket ids
 * are aligned to the global UTC hour rather than to a period. Reading it per
 * period loses an hour at every renewal: `reported_through` only ever reaches
 * the last *settled* hour, so it sits behind the new `period_start` the moment
 * the renewal lands, and a per-period read then restarts at
 * `floorHour(newPeriodStart)` — the bucket in between is abandoned by the old
 * row and never reached by the new one. That is a permanent under-bill, once
 * per team per cycle, and silent.
 *
 * Resuming from the maximum can only ever *re-emit* a bucket, never skip one,
 * and re-emission is free: the provider deduplicates on `externalId`.
 */
export async function reportedThroughMax(teamId: string): Promise<Date | null> {
  const [row] = await db()
    .select({ max: max(billingUsage.reportedThrough) })
    .from(billingUsage)
    .where(eq(billingUsage.teamId, teamId));
  // An aggregate has no column behind it, so the driver hands back whatever
  // Postgres printed rather than a decoded `Date` — the same trap as the
  // epoch-seconds bucket key below. Coerced here so no caller has to know.
  const value: Date | string | null = row?.max ?? null;
  return value === null || value instanceof Date ? value : new Date(value);
}

// --------------------------------------------------------------- rollup

const HOUR_MS = 3600 * 1000;

/**
 * How long after an hour closes before it is reported. Sends resolve within
 * minutes, so half an hour is generous; the point is that a bucket is counted
 * once, after its rows have stopped moving between statuses.
 */
export const SETTLE_MS = 30 * 60 * 1000;

/** Most buckets one team gets in one run, so a long outage catches up over several. */
export const MAX_BUCKETS_PER_RUN = 168; // one week

/** Truncate to the UTC hour. */
export const floorHour = (d: Date): Date =>
  new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);

/**
 * Deterministic id for one team's bucket. The provider deduplicates on it,
 * which is what makes re-sending after a failed or timed-out ingest free —
 * and what makes the overlap at a billing-period boundary harmless.
 */
export const usageExternalId = (teamId: string, bucketStart: Date): string =>
  `${teamId}:${bucketStart.toISOString()}`;

/**
 * Closed, UTC-hour-aligned buckets from `from` (floored to the hour) up to
 * the settle horizon, capped at `MAX_BUCKETS_PER_RUN`.
 *
 * Alignment is global, not relative to a billing period: an email belongs to
 * exactly one bucket for all time, so a period boundary can only re-emit a
 * bucket whose id the provider has already seen. The horizon is floored too,
 * so the hour in progress is never reported — counting a bucket that is still
 * being written to would move the watermark past the rest of it forever.
 */
export function hourlyBuckets(from: Date, now: Date): UsageWindow[] {
  const horizon = floorHour(new Date(now.getTime() - SETTLE_MS));
  const out: UsageWindow[] = [];
  for (
    let t = floorHour(from).getTime();
    t < horizon.getTime() && out.length < MAX_BUCKETS_PER_RUN;
    t += HOUR_MS
  )
    out.push({ start: new Date(t), end: new Date(t + HOUR_MS) });
  return out;
}

/**
 * Billable emails per UTC hour for one team over `[from, to)`, keyed by the
 * bucket start in epoch milliseconds.
 *
 * The bucket key comes back as epoch seconds, not a timestamp: `date_trunc`
 * over `at time zone 'UTC'` yields a `timestamp without time zone`, which the
 * driver would parse in the *process's* local zone — correct in a UTC
 * container, wrong on a developer's machine. Epoch seconds have no zone.
 */
export async function countByHour(
  teamId: string,
  from: Date,
  to: Date,
): Promise<Map<number, number>> {
  const bucketEpoch = sql<string>`extract(epoch from date_trunc('hour', ${emails.createdAt} at time zone 'UTC'))::bigint`;
  const rows = await db()
    .select({ bucketEpoch, n: count() })
    .from(emails)
    .where(
      and(
        eq(emails.teamId, teamId),
        gte(emails.createdAt, from),
        lt(emails.createdAt, to),
        inArray(emails.status, [...BILLABLE]),
      ),
    )
    .groupBy(bucketEpoch);
  const out = new Map<number, number>();
  for (const r of rows) out.set(Number(r.bucketEpoch) * 1000, Number(r.n));
  return out;
}

/** One team's pending usage: the events to send and the watermark they reach. */
export interface TeamRollup {
  teamId: string;
  /** The **stored** `team_billing.period_start`; see `meteringPeriodStart`. */
  periodStart: Date;
  periodEnd: Date;
  events: UsageEvent[];
  /** Exclusive end of the last bucket in `events` (or of the settled range). */
  through: Date;
  units: number;
}

/**
 * Build (do not send) the pending rollup for one team.
 *
 * Buckets with no sends produce no event but still advance the watermark:
 * there is nothing to meter and re-scanning an empty hour forever would be
 * pointless work.
 *
 * `periodStart` is the key the `billing_usage` row lives under and must be the
 * **stored** `team_billing.period_start`, never a window an entitlement
 * resolved to — see `meteringPeriodStart` in `./plans`.
 */
export async function planTeamRollup(
  teamId: string,
  periodStart: Date,
  periodEnd: Date,
  eventName: string,
  now: Date,
): Promise<TeamRollup | null> {
  // Across every period, not just this one: a renewal moves `period_start`
  // past the last settled hour, and reading the watermark per period would
  // abandon the bucket in between. See `reportedThroughMax`.
  const from = (await reportedThroughMax(teamId)) ?? floorHour(periodStart);
  const buckets = hourlyBuckets(from, now);
  if (buckets.length === 0) return null;
  const counts = await countByHour(
    teamId,
    buckets[0]!.start,
    buckets.at(-1)!.end,
  );
  const events: UsageEvent[] = [];
  let units = 0;
  for (const b of buckets) {
    const n = counts.get(b.start.getTime()) ?? 0;
    if (n === 0) continue;
    units += n;
    events.push({
      externalId: usageExternalId(teamId, b.start),
      externalCustomerId: teamId,
      name: eventName,
      count: n,
      timestamp: b.start,
    });
  }
  return {
    teamId,
    periodStart,
    periodEnd,
    events,
    through: buckets.at(-1)!.end,
    units,
  };
}

/** Move a team's watermark forward. Only ever called after a 2xx ingest. */
export async function commitRollup(r: TeamRollup, now: Date): Promise<void> {
  const set = {
    periodEnd: r.periodEnd,
    reportedThrough: r.through,
    reportedUnits: sql`${billingUsage.reportedUnits} + ${r.units}`,
    // `$onUpdate` does not fire on an upsert.
    updatedAt: now,
  };
  await db()
    .insert(billingUsage)
    .values({
      teamId: r.teamId,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      reportedThrough: r.through,
      reportedUnits: r.units,
    })
    .onConflictDoUpdate({
      target: [billingUsage.teamId, billingUsage.periodStart],
      set,
    });
}

/** Events per ingest call. A team's whole run fits in one chunk by construction. */
const CHUNK_EVENTS = 500;

export interface RollupSummary {
  teams: number;
  events: number;
  units: number;
  failed: number;
}

/**
 * Meter every team that has a provider customer, in one pass.
 *
 * Teams are packed whole into chunks — one team's buckets are capped at 168,
 * far under the chunk size, so a team never straddles two calls. A chunk that
 * fails leaves the watermarks of every team in it untouched: the next run
 * rebuilds exactly the same buckets with exactly the same `externalId`s, and
 * the provider deduplicates whatever did land.
 *
 * **The provider being down must never affect sending.** This runs only on
 * the cron, never on the send path, and it swallows every provider error.
 */
export async function rollupUsage(
  provider: BillingProvider,
  eventName: string,
  now = new Date(),
): Promise<RollupSummary> {
  const teams = await db()
    .select()
    .from(teamBilling)
    .where(isNotNull(teamBilling.providerCustomerId));

  const pending: TeamRollup[] = [];
  for (const t of teams) {
    // Deliberately **not** `entitlementFrom(t, now).periodStart`: entitlement
    // substitutes the calendar month whenever the stored period does not
    // contain `now` (a renewal webhook that has not landed yet, a
    // non-entitling status), so keying on it would have one run key on the
    // provider period and the next on the calendar month — a second usage row
    // accumulating for hours the first already counted, the watermark reset,
    // and the whole period re-emitted. `meteringPeriodStart` is the same key
    // `teamBillingState` reads the row back under.
    const r = await planTeamRollup(
      t.teamId,
      meteringPeriodStart(t, now),
      t.periodEnd,
      eventName,
      now,
    );
    if (r) pending.push(r);
  }

  const summary: RollupSummary = {
    teams: pending.length,
    events: 0,
    units: 0,
    failed: 0,
  };
  let chunk: TeamRollup[] = [];
  let chunkSize = 0;

  const flush = async () => {
    if (chunk.length === 0) return;
    const events = chunk.flatMap((r) => r.events);
    try {
      if (events.length > 0) await provider.ingestUsage(events);
      for (const r of chunk) await commitRollup(r, now);
      summary.events += events.length;
      summary.units += chunk.reduce((n, r) => n + r.units, 0);
    } catch (e) {
      // Watermarks stay put; the next tick re-sends the same externalIds.
      summary.failed += chunk.length;
      console.error(
        `[billing] usage ingest failed for ${chunk.length} team(s); will retry next tick:`,
        (e as Error).message,
      );
    }
    chunk = [];
    chunkSize = 0;
  };

  for (const r of pending) {
    if (chunkSize + r.events.length > CHUNK_EVENTS) await flush();
    chunk.push(r);
    chunkSize += r.events.length;
  }
  await flush();
  return summary;
}
