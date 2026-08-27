import { and, count, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { SEND_CONSUMING_STATUS, type ErrorCode } from "@sendsprite/shared";
import { db } from "@/db";
import { emails, teamSendRate, teamSettings } from "@/db/schema";
import { billingEnabled } from "./billing/config";
import { billingRow, entitlementFrom } from "./billing/plans";
import { getInstanceSettings } from "./instance-settings";
import { getTeamAws } from "./team-aws";

export type TokenResult = { ok: true } | { ok: false; retryInMs: number };
export type CapResult =
  { ok: true } | { ok: false; code: ErrorCode; message: string };

/**
 * Statuses that consumed (or will consume) a send; failed/cancelled never
 * count. Shared with the usage meter (`billing/usage.ts` re-exports it as
 * `BILLABLE`) so the rows a cap refuses and the rows an invoice charges for
 * can never drift apart.
 */
const ACTIVE = SEND_CONSUMING_STATUS;

/**
 * One token = one SES SendEmail, for one team. Refills continuously at that
 * team's MaxSendRate/s with burst = MaxSendRate (min 1), so an idle bucket
 * never stores more than one second of sends. The team's row is read
 * `FOR UPDATE` inside the transaction, which serialises concurrent takers
 * across workers **for that team** — one tenant's volume no longer drains the
 * bucket every other tenant draws from.
 */
export async function takeSesToken(
  teamId: string,
  now = new Date(),
): Promise<TokenResult> {
  const aws = await getTeamAws(teamId);
  const rate = Math.max(1, aws?.sesMaxSendRate ?? 1);
  return db().transaction(async (tx) => {
    await tx
      .insert(teamSendRate)
      .values({ teamId, tokens: rate, refilledAt: now })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(teamSendRate)
      .where(eq(teamSendRate.teamId, teamId))
      .for("update");
    if (!row) throw new Error("team_send_rate row missing");
    // A lagging clock (another worker's `now` behind the stamp) earns nothing
    // and must not rewind the stamp, or the next taker double-credits.
    const stamp = Math.max(now.getTime(), row.refilledAt.getTime());
    const elapsed = (stamp - row.refilledAt.getTime()) / 1000;
    const tokens = Math.min(rate, row.tokens + elapsed * rate);
    const ok = tokens >= 1;
    await tx
      .update(teamSendRate)
      .set({ tokens: ok ? tokens - 1 : tokens, refilledAt: new Date(stamp) })
      .where(eq(teamSendRate.teamId, teamId));
    return ok
      ? { ok: true }
      : { ok: false, retryInMs: Math.ceil(((1 - tokens) / rate) * 1000) };
  });
}

/** Empties the bucket as of `now`; tests use it to control the clock. */
export async function resetRateForTests(
  teamId: string,
  now: Date,
): Promise<void> {
  await db()
    .insert(teamSendRate)
    .values({ teamId, tokens: 0, refilledAt: now })
    .onConflictDoUpdate({
      target: teamSendRate.teamId,
      set: { tokens: 0, refilledAt: now },
    });
}

const startOfDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const startOfMonth = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

async function countActiveSince(teamId: string, since: Date) {
  const [row] = await db()
    .select({ n: count() })
    .from(emails)
    .where(
      and(
        eq(emails.teamId, teamId),
        gte(emails.createdAt, since),
        inArray(emails.status, [...ACTIVE]),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Active-status emails a team created inside `[from, to)`. */
async function countActiveBetween(teamId: string, from: Date, to: Date) {
  const [row] = await db()
    .select({ n: count() })
    .from(emails)
    .where(
      and(
        eq(emails.teamId, teamId),
        gte(emails.createdAt, from),
        lt(emails.createdAt, to),
        inArray(emails.status, [...ACTIVE]),
      ),
    );
  return Number(row?.n ?? 0);
}

export interface TeamCaps {
  /** Emails per UTC day, or null when unlimited. */
  daily: number | null;
  /** Emails per billing window, or null when unlimited. */
  monthly: number | null;
  /** Start of the window `monthly` is measured over. */
  monthlyFrom: Date;
  /** Exclusive end of that window — what `x-ratelimit-reset` reports. */
  monthlyUntil: Date;
  /**
   * Where the numbers came from, for the refusal message and the UI.
   *
   * `instance` is the operator's default for a team nobody has decided about;
   * `settings` is a decision somebody made about this team specifically.
   */
  source: "settings" | "plan" | "instance" | "none";
  /** Plan name when a plan supplied a cap; used in the refusal message. */
  planName: string | null;
}

const PLAN_LABEL: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  scale: "Scale",
};

const monthWindow = (now: Date) => ({
  from: startOfMonth(now),
  until: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
});

/**
 * The caps in force for a team, from two sources with a fixed precedence:
 *
 * 1. `team_settings.daily_limit` / `monthly_limit` — the operator's escape
 *    hatch. Set, they win, on a hosted instance as well as a self-hosted one,
 *    column by column (so one team's monthly cap can be lifted without
 *    unsetting its plan).
 * 2. The billing plan, and only when `BILLING_ENABLED` is on. A self-hosted
 *    instance therefore behaves exactly as it did before this phase: no plan,
 *    no cap, this branch never taken — a `team_billing` row left behind by a
 *    restore from a hosted backup caps nothing.
 *
 * The monthly window is the subscription's billing period, not the calendar
 * month, so a customer who subscribed on the 10th gets their allowance on the
 * 10th. `entitlementFrom` rolls that period forward onto its next
 * anniversary when the stored one has gone stale; that substitution is
 * entitlement-only and must not be reused as a metering key (see
 * `meteringPeriodStart`).
 */
export async function resolveTeamCaps(
  teamId: string,
  now = new Date(),
): Promise<TeamCaps> {
  const [[ts], instance] = await Promise.all([
    db()
      .select({
        daily: teamSettings.dailyLimit,
        monthly: teamSettings.monthlyLimit,
      })
      .from(teamSettings)
      .where(eq(teamSettings.teamId, teamId)),
    getInstanceSettings(),
  ]);
  const month = monthWindow(now);

  /*
   * The instance-wide floor, under a team that has none of its own.
   *
   * Precedence is team, then plan, then instance: an operator's default is the
   * value for a team nobody has decided about, not an override of one somebody
   * has. It exists because an open-signup instance had no cap at all until an
   * operator noticed a new team and set one by hand.
   */
  const daily = ts?.daily ?? instance.defaultDailyLimit ?? null;

  if (!billingEnabled()) {
    const monthly = ts?.monthly ?? instance.defaultMonthlyLimit ?? null;
    return {
      daily,
      monthly,
      monthlyFrom: month.from,
      monthlyUntil: month.until,
      source:
        ts?.daily != null || ts?.monthly != null
          ? "settings"
          : daily != null || monthly != null
            ? "instance"
            : "none",
      planName: null,
    };
  }

  /*
   * With billing on, the monthly allowance is the plan's and the instance
   * default does not touch it — including when the plan says there is none.
   * A plan with overage is a decision that this team may send without a
   * ceiling, and an operator default meant for teams nobody has decided about
   * must not quietly overrule it. The default daily still applies: plans
   * govern volume over a period, not the rate on any one day.
   */
  const e = entitlementFrom(await billingRow(teamId), now);
  const settingsWins = ts?.daily != null || ts?.monthly != null;
  const dailyFromInstance =
    ts?.daily == null && instance.defaultDailyLimit != null;
  return {
    daily,
    monthly: ts?.monthly ?? e.monthlyCap,
    monthlyFrom: ts?.monthly != null ? month.from : e.periodStart,
    monthlyUntil: ts?.monthly != null ? month.until : e.periodEnd,
    source: settingsWins
      ? "settings"
      : e.monthlyCap == null && dailyFromInstance
        ? "instance"
        : "plan",
    planName: ts?.monthly != null ? null : e.plan,
  };
}

/**
 * The team's suspension, or null.
 *
 * Its own query rather than a column added to `resolveTeamCaps`: that
 * function answers "how much may this team send", and a suspension is not a
 * quantity. Keeping them apart is what lets the refusal above name a reason
 * instead of reporting a limit of zero, which is what an operator's
 * suspension would otherwise look like to a customer reading an error.
 */
export async function teamSuspension(
  teamId: string,
): Promise<{ at: Date; reason: string | null } | null> {
  const [row] = await db()
    .select({
      at: teamSettings.suspendedAt,
      reason: teamSettings.suspendedReason,
    })
    .from(teamSettings)
    .where(eq(teamSettings.teamId, teamId))
    .limit(1);
  return row?.at ? { at: row.at, reason: row.reason } : null;
}

/**
 * Per-team daily/monthly caps. UTC calendar day for the daily cap; the
 * billing period (or the UTC month) for the monthly one. Counts by
 * `createdAt` (reservation semantics: an email scheduled for later counts
 * against the window it was created in). Check-then-insert is not atomic, so
 * concurrent creates can overshoot a cap by a few — the caps are soft.
 */
export async function checkTeamCaps(
  teamId: string,
  adding: number,
  now = new Date(),
): Promise<CapResult> {
  // Suspension is checked here rather than at each entry point precisely
  // because there are five of them — REST, SMTP, campaign fan-out, the
  // dashboard and the batch endpoint — and every one already runs the caps.
  // A suspension enforced anywhere else is a suspension with a hole in it.
  const suspended = await teamSuspension(teamId);
  if (suspended)
    return {
      ok: false,
      code: "forbidden",
      message: suspended.reason
        ? `Sending is suspended for this team: ${suspended.reason}`
        : "Sending is suspended for this team. Contact the operator of this instance.",
    };
  const caps = await resolveTeamCaps(teamId, now);
  if (caps.daily == null && caps.monthly == null) return { ok: true };
  if (
    caps.daily != null &&
    (await countActiveSince(teamId, startOfDay(now))) + adding > caps.daily
  )
    return {
      ok: false,
      code: "daily_quota_exceeded",
      message: `Daily limit of ${caps.daily.toLocaleString("en-US")} emails reached.`,
    };
  if (
    caps.monthly != null &&
    (await countActiveBetween(teamId, caps.monthlyFrom, caps.monthlyUntil)) +
      adding >
      caps.monthly
  ) {
    const plan = caps.planName
      ? ` on the ${PLAN_LABEL[caps.planName] ?? caps.planName} plan`
      : "";
    return {
      ok: false,
      code: "monthly_quota_exceeded",
      message: `Monthly limit of ${caps.monthly.toLocaleString("en-US")} emails${plan} reached.`,
    };
  }
  return { ok: true };
}

/** Sends SES accepted (`sent_at`) for one team in the trailing 24 h. */
async function countSentLast24h(teamId: string, now: Date) {
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const [row] = await db()
    .select({ n: count() })
    .from(emails)
    .where(
      and(
        eq(emails.teamId, teamId),
        isNotNull(emails.sentAt),
        gte(emails.sentAt, since),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * SES Max24HourSend is account-wide, and every team now has its own AWS
 * account — so "account-wide" means that team's sends in the trailing 24 h
 * (`sent_at`, set once SES accepted the message). In-flight `sending` rows
 * have no `sent_at` yet and are not counted, so this too is a soft cap; SES
 * itself is the hard one.
 */
export async function checkAccountQuota(
  teamId: string,
  adding: number,
  now = new Date(),
): Promise<CapResult> {
  const aws = await getTeamAws(teamId);
  if (!aws?.sesDailyQuota) return { ok: true };
  return (await countSentLast24h(teamId, now)) + adding > aws.sesDailyQuota
    ? {
        ok: false,
        code: "daily_quota_exceeded",
        message: `SES 24-hour quota of ${aws.sesDailyQuota} reached.`,
      }
    : { ok: true };
}

export interface UsageSnapshot {
  /** Daily cap, null when unlimited. */
  dailyLimit: number | null;
  /** Emails created today (UTC) that count against the daily cap. */
  dailyUsed: number;
  /** Monthly cap (plan or settings), null when unlimited. */
  monthlyLimit: number | null;
  /** Emails created in the monthly window that count against it. */
  monthlyUsed: number;
  /** Start of that window (billing period or UTC month). */
  monthlyFrom: Date;
  /** Exclusive end of that window. */
  monthlyUntil: Date;
  /** The team's SES Max24HourSend, null when AWS is not connected. */
  accountQuota: number | null;
  /** That team's sends in the trailing 24 h. */
  accountUsed: number;
}

/**
 * What the REST rate-limit headers report. The account count used to be a
 * scan of every team's sends, skipped whenever the team had a cap of its own
 * — which meant it sometimes reported 0 and callers had to know not to
 * believe it. Scoped to the team it is an indexed lookup, so it is always
 * real.
 */
export async function usageSnapshot(
  teamId: string,
  now = new Date(),
): Promise<UsageSnapshot> {
  const caps = await resolveTeamCaps(teamId, now);
  const aws = await getTeamAws(teamId);
  return {
    dailyLimit: caps.daily,
    dailyUsed:
      caps.daily != null ? await countActiveSince(teamId, startOfDay(now)) : 0,
    monthlyLimit: caps.monthly,
    monthlyUsed:
      caps.monthly != null
        ? await countActiveBetween(teamId, caps.monthlyFrom, caps.monthlyUntil)
        : 0,
    monthlyFrom: caps.monthlyFrom,
    monthlyUntil: caps.monthlyUntil,
    accountQuota: aws?.sesDailyQuota ?? null,
    accountUsed: await countSentLast24h(teamId, now),
  };
}
