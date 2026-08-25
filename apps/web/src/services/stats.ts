import { sql } from "drizzle-orm";
import { db } from "@/db";

export interface SendStats {
  sent: { today: number; d7: number; d30: number };
  /** Over emails sent in the last 30 days. */
  rates: { delivered: number; bounced: number; complained: number };
  alerts: StatsAlert[];
}
export interface StatsAlert {
  kind: "bounce" | "complaint";
  level: "warning" | "critical";
  rate: number;
  window: "24h";
}

/** SES account-health thresholds (spec §12): warn a little before SES does. */
export const THRESHOLDS = {
  bounce: { warning: 0.04, critical: 0.05 },
  complaint: { warning: 0.0008, critical: 0.001 },
} as const;
/** Below this many sends in 24 h a single bounce would trip the alert. */
const MIN_SAMPLE = 20;

const HOUR = 3_600_000;

type Counts = {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
};

/**
 * One pass over the emails sent in `(since, now]`: the denominator is the
 * `sent_at` window, each numerator counts emails (not events) that have at
 * least one event of that type, so duplicates never inflate a rate.
 */
async function counts(
  teamId: string | null,
  since: Date,
  now: Date,
): Promise<Counts> {
  const has = (type: string) =>
    sql`count(*) filter (where exists (select 1 from email_events ev where ev.email_id = e.id and ev.type = ${type}))::int`;
  const rows = await db().execute<Counts>(sql`
    select
      count(*)::int as sent,
      ${has("delivered")} as delivered,
      ${has("bounced")} as bounced,
      ${has("complained")} as complained
    from emails e
    where e.sent_at > ${since.toISOString()}::timestamptz
      and e.sent_at <= ${now.toISOString()}::timestamptz
      ${teamId ? sql`and e.team_id = ${teamId}` : sql``}
  `);
  return rows[0] ?? { sent: 0, delivered: 0, bounced: 0, complained: 0 };
}

const ratio = (n: number, d: number) => (d ? n / d : 0);

function alertsFor(c: Counts): StatsAlert[] {
  if (c.sent < MIN_SAMPLE) return [];
  const out: StatsAlert[] = [];
  const check = (kind: StatsAlert["kind"], n: number) => {
    const rate = ratio(n, c.sent);
    const t = THRESHOLDS[kind];
    const level =
      rate >= t.critical ? "critical" : rate >= t.warning ? "warning" : null;
    if (level) out.push({ kind, level, rate, window: "24h" });
  };
  check("bounce", c.bounced);
  check("complaint", c.complained);
  return out;
}

async function stats(teamId: string | null, now: Date): Promise<SendStats> {
  const [h24, d7, d30] = await Promise.all([
    counts(teamId, new Date(now.getTime() - 24 * HOUR), now),
    counts(teamId, new Date(now.getTime() - 7 * 24 * HOUR), now),
    counts(teamId, new Date(now.getTime() - 30 * 24 * HOUR), now),
  ]);
  return {
    sent: { today: h24.sent, d7: d7.sent, d30: d30.sent },
    rates: {
      delivered: ratio(d30.delivered, d30.sent),
      bounced: ratio(d30.bounced, d30.sent),
      complained: ratio(d30.complained, d30.sent),
    },
    alerts: alertsFor(h24),
  };
}

/** `today` is a rolling 24 h window, not a calendar day. */
export const teamStats = (teamId: string, now = new Date()) =>
  stats(teamId, now);

/** Same, across every team: the owner-only instance health banner. */
export const instanceStats = (now = new Date()) => stats(null, now);
