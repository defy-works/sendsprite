import { and, count, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import type { ErrorCode } from "@sendsprite/shared";
import { db } from "@/db";
import { emails, sendRateState, teamSettings } from "@/db/schema";
import { billingEnabled } from "./billing/config";
import { billingRow, entitlementFrom } from "./billing/plans";
import { getInstanceSettings } from "./instance-settings";

export type TokenResult = { ok: true } | { ok: false; retryInMs: number };
export type CapResult =
  { ok: true } | { ok: false; code: ErrorCode; message: string };

/** Statuses that consumed (or will consume) a send; failed/cancelled never count. */
const ACTIVE = [
  "queued",
  "scheduled",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "complained",
] as const;

/**
 * One token = one SES SendEmail. Refills continuously at MaxSendRate/s with
 * burst = MaxSendRate (min 1), so an idle bucket never stores more than one
 * second of sends. The singleton row is read `FOR UPDATE` inside the
 * transaction, which serialises concurrent takers across workers.
 */
export async function takeSesToken(now = new Date()): Promise<TokenResult> {
  const s = await getInstanceSettings();
  const rate = Math.max(1, s.sesMaxSendRate ?? 1);
  return db().transaction(async (tx) => {
    await tx
      .insert(sendRateState)
      .values({ id: 1, tokens: rate, refilledAt: now })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(sendRateState)
      .where(eq(sendRateState.id, 1))
      .for("update");
    if (!row) throw new Error("send_rate_state singleton missing");
    // A lagging clock (another worker's `now` behind the stamp) earns nothing
    // and must not rewind the stamp, or the next taker double-credits.
    const stamp = Math.max(now.getTime(), row.refilledAt.getTime());
    const elapsed = (stamp - row.refilledAt.getTime()) / 1000;
    const tokens = Math.min(rate, row.tokens + elapsed * rate);
    const ok = tokens >= 1;
    await tx
      .update(sendRateState)
      .set({ tokens: ok ? tokens - 1 : tokens, refilledAt: new Date(stamp) })
      .where(eq(sendRateState.id, 1));
    return ok
      ? { ok: true }
      : { ok: false, retryInMs: Math.ceil(((1 - tokens) / rate) * 1000) };
  });
}

/** Empties the bucket as of `now`; tests use it to control the clock. */
export async function resetRateForTests(now: Date): Promise<void> {
  await db()
    .insert(sendRateState)
    .values({ id: 1, tokens: 0, refilledAt: now })
    .onConflictDoUpdate({
      target: sendRateState.id,
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
  /** Where the numbers came from, for the refusal message and the UI. */
  source: "settings" | "plan" | "none";
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
 * 10th. `entitlementFrom` falls back to the calendar month when the stored
 * period has gone stale; that substitution is entitlement-only and must not
 * be reused as a metering key (see `meteringPeriodStart`).
 */
export async function resolveTeamCaps(
  teamId: string,
  now = new Date(),
): Promise<TeamCaps> {
  const [ts] = await db()
    .select({
      daily: teamSettings.dailyLimit,
      monthly: teamSettings.monthlyLimit,
    })
    .from(teamSettings)
    .where(eq(teamSettings.teamId, teamId));
  const month = monthWindow(now);

  if (!billingEnabled())
    return {
      daily: ts?.daily ?? null,
      monthly: ts?.monthly ?? null,
      monthlyFrom: month.from,
      monthlyUntil: month.until,
      source: ts?.daily != null || ts?.monthly != null ? "settings" : "none",
      planName: null,
    };

  const e = entitlementFrom(await billingRow(teamId), now);
  const settingsWins = ts?.daily != null || ts?.monthly != null;
  return {
    daily: ts?.daily ?? null,
    monthly: ts?.monthly ?? e.monthlyCap,
    monthlyFrom: ts?.monthly != null ? month.from : e.periodStart,
    monthlyUntil: ts?.monthly != null ? month.until : e.periodEnd,
    source: settingsWins ? "settings" : "plan",
    planName: ts?.monthly != null ? null : e.plan,
  };
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

/** Sends SES accepted (`sent_at`) instance-wide in the trailing 24 h. */
async function countSentLast24h(now: Date) {
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const [row] = await db()
    .select({ n: count() })
    .from(emails)
    .where(and(isNotNull(emails.sentAt), gte(emails.sentAt, since)));
  return Number(row?.n ?? 0);
}

/**
 * SES Max24HourSend is account-wide: count every send across the instance in
 * the trailing 24 h (`sent_at`, which is set once SES accepted the message).
 * In-flight `sending` rows have no `sent_at` yet and are not counted, so this
 * too is a soft cap; SES itself is the hard one.
 */
export async function checkInstanceQuota(
  adding: number,
  now = new Date(),
): Promise<CapResult> {
  const s = await getInstanceSettings();
  if (!s.sesDailyQuota) return { ok: true };
  return (await countSentLast24h(now)) + adding > s.sesDailyQuota
    ? {
        ok: false,
        code: "daily_quota_exceeded",
        message: `SES 24-hour quota of ${s.sesDailyQuota} reached.`,
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
  /** SES Max24HourSend, null when unknown (AWS not connected). */
  instanceQuota: number | null;
  /** Instance-wide sends in the trailing 24 h. */
  instanceUsed: number;
}

/**
 * What the REST rate-limit headers report. The instance-wide count (a scan of
 * every team's sends) is skipped whenever the team has a cap of its own.
 */
export async function usageSnapshot(
  teamId: string,
  now = new Date(),
): Promise<UsageSnapshot> {
  const caps = await resolveTeamCaps(teamId, now);
  const s = await getInstanceSettings();
  const capped = caps.daily != null || caps.monthly != null;
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
    instanceQuota: s.sesDailyQuota ?? null,
    instanceUsed: capped ? 0 : await countSentLast24h(now),
  };
}
