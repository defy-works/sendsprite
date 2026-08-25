import { and, count, eq, gte, inArray, isNotNull } from "drizzle-orm";
import type { ErrorCode } from "@sendsprite/shared";
import { db } from "@/db";
import { emails, sendRateState, teamSettings } from "@/db/schema";
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
    const elapsed = Math.max(
      0,
      (now.getTime() - row.refilledAt.getTime()) / 1000,
    );
    const tokens = Math.min(rate, row.tokens + elapsed * rate);
    const ok = tokens >= 1;
    await tx
      .update(sendRateState)
      .set({ tokens: ok ? tokens - 1 : tokens, refilledAt: now })
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

/** Per-team daily/monthly caps (`team_settings`), UTC calendar windows. */
export async function checkTeamCaps(
  teamId: string,
  adding: number,
  now = new Date(),
): Promise<CapResult> {
  const [ts] = await db()
    .select({
      daily: teamSettings.dailyLimit,
      monthly: teamSettings.monthlyLimit,
    })
    .from(teamSettings)
    .where(eq(teamSettings.teamId, teamId));
  if (!ts) return { ok: true };
  if (
    ts.daily != null &&
    (await countActiveSince(teamId, startOfDay(now))) + adding > ts.daily
  )
    return {
      ok: false,
      code: "daily_quota_exceeded",
      message: `Daily limit of ${ts.daily} emails reached.`,
    };
  if (
    ts.monthly != null &&
    (await countActiveSince(teamId, startOfMonth(now))) + adding > ts.monthly
  )
    return {
      ok: false,
      code: "monthly_quota_exceeded",
      message: `Monthly limit of ${ts.monthly} emails reached.`,
    };
  return { ok: true };
}

/**
 * SES Max24HourSend is account-wide: count every send across the instance in
 * the trailing 24 h (`sent_at`, which is set once SES accepted the message).
 */
export async function checkInstanceQuota(
  adding: number,
  now = new Date(),
): Promise<CapResult> {
  const s = await getInstanceSettings();
  if (!s.sesDailyQuota) return { ok: true };
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const [row] = await db()
    .select({ n: count() })
    .from(emails)
    .where(and(isNotNull(emails.sentAt), gte(emails.sentAt, since)));
  return Number(row?.n ?? 0) + adding > s.sesDailyQuota
    ? {
        ok: false,
        code: "daily_quota_exceeded",
        message: `SES 24-hour quota of ${s.sesDailyQuota} reached.`,
      }
    : { ok: true };
}
