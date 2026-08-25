import { eq } from "drizzle-orm";
import {
  FREE_PLAN_METADATA,
  isEntitledStatus,
  type Plan,
} from "@sendsprite/shared";
import { db, type Db } from "@/db";
import { teamBilling, type TeamBilling } from "@/db/schema";

/**
 * A drizzle client or an open transaction. Webhook application runs entirely
 * inside one transaction (the `billing_events` insert, the entitlement write
 * and the `applied_at` mark commit together), so every read it performs has to
 * be able to run on the transaction handle rather than the pool — a read on a
 * second connection would not see the row the transaction just wrote.
 */
export type DbClient = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface UsageWindow {
  start: Date;
  /** Exclusive. */
  end: Date;
}

/** What a team is entitled to right now. The only thing caps and UI read. */
export interface Entitlement {
  plan: Plan;
  status: string | null;
  includedEmails: number;
  overagePer1kCents: number;
  /** The subscription bills overage, so `includedEmails` is not a ceiling. */
  overageEnabled: boolean;
  /** Hard monthly cap, or null when the excess is billed instead. */
  monthlyCap: number | null;
  cancelAtPeriodEnd: boolean;
  periodStart: Date;
  periodEnd: Date;
  /** There is a provider subscription row behind this. */
  managed: boolean;
  /**
   * When the subscription went past due, or null. Carried through even after
   * the grace window has expired and the caps have dropped to Free, because
   * the dashboard renders the deadline from it.
   */
  pastDueAt: Date | null;
}

/**
 * How long a `past_due` subscription keeps its paid caps.
 *
 * `isEntitledStatus("past_due")` is `true` and stays true: cutting a customer
 * off the hour a card expires is a worse failure than carrying them through
 * the provider's dunning. But *indefinitely* entitled is a different thing —
 * a dead card would buy unlimited sending until the provider eventually flips
 * the status, which for a metered subscription can be weeks. The clock lives
 * here rather than in the status because only entitlement resolution knows
 * when the subscription went past due.
 */
export const PAST_DUE_GRACE_MS = 7 * 24 * 3600 * 1000;

/** UTC calendar month containing `now`, half-open `[start, end)`. */
export const calendarMonth = (now: Date): UsageWindow => ({
  start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
});

/** What a team with no subscription gets. */
export const FREE_ENTITLEMENT = (now: Date): Entitlement => {
  const w = calendarMonth(now);
  return {
    plan: FREE_PLAN_METADATA.plan,
    status: null,
    includedEmails: FREE_PLAN_METADATA.includedEmails,
    overagePer1kCents: FREE_PLAN_METADATA.overagePer1kCents,
    overageEnabled: false,
    monthlyCap: FREE_PLAN_METADATA.includedEmails,
    cancelAtPeriodEnd: false,
    periodStart: w.start,
    periodEnd: w.end,
    managed: false,
    pastDueAt: null,
  };
};

/** The subset of `team_billing` entitlement resolution reads. */
export type BillingSnapshot = Pick<
  TeamBilling,
  | "plan"
  | "status"
  | "includedEmails"
  | "overagePer1kCents"
  | "overageEnabled"
  | "cancelAtPeriodEnd"
  | "periodStart"
  | "periodEnd"
  | "pastDueAt"
>;

/**
 * The window the customer is actually in, when the stored one has gone stale.
 *
 * A renewal webhook can lag, and an empty window would mean no cap at all — but
 * substituting the *calendar month* is wrong in the other direction: it moves
 * the allowance boundary to the 1st for a customer who bought on the 10th, so
 * sends already counted against the previous period are counted again and a
 * customer who has just paid is refused. Rolling the stored period forward by
 * its own length keeps the anniversary they bought.
 *
 * Whole periods only, so the window always contains `now` (the arithmetic
 * handles a stored period that has not started yet — clock skew, a scheduled
 * change — by rolling backwards). A period whose length is not positive is not
 * something to extrapolate from; the calendar month is the last resort.
 *
 * Rolling by elapsed *length* rather than by calendar month drifts for a
 * customer whose anniversary is near the end of a month, but only while the
 * renewal is late, and by less than the calendar-month jump it replaces.
 */
const currentWindow = (row: BillingSnapshot, now: Date): UsageWindow => {
  const start = row.periodStart.getTime();
  const end = row.periodEnd.getTime();
  if (start <= now.getTime() && now.getTime() < end)
    return { start: row.periodStart, end: row.periodEnd };
  const length = end - start;
  if (!(length > 0)) return calendarMonth(now);
  const n = Math.floor((now.getTime() - start) / length);
  return {
    start: new Date(start + n * length),
    end: new Date(start + (n + 1) * length),
  };
};

/** Free caps, but still a managed team: the portal must stay reachable. */
const freeButManaged = (row: BillingSnapshot, now: Date): Entitlement => ({
  ...FREE_ENTITLEMENT(now),
  status: row.status,
  cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  pastDueAt: row.pastDueAt,
  managed: true,
});

/**
 * Snapshot to entitlement. Pure, so the interesting cases are unit-tested:
 *
 * - No row, or a status that does not entitle (`canceled`, `unpaid`,
 *   `incomplete`): the free plan's caps. `managed` stays true when a row
 *   exists, so the UI can still offer the customer portal.
 * - `past_due` past its grace window: the same free caps, with the status and
 *   `pastDueAt` carried so the banner can say why. Inside the window the paid
 *   caps stand — see `PAST_DUE_GRACE_MS`.
 * - Cancelled at the period end, and that end has passed: free caps, whether
 *   or not the revoke webhook ever arrived. The status alone cannot be
 *   trusted here — the provider leaves it `active` until the period ends —
 *   and a row whose revocation was lost would otherwise be handed a fresh
 *   allowance every month, for ever.
 * - Entitled with a metered price: no monthly cap. The customer has agreed to
 *   pay for the excess and blocking their sending would be the wrong failure.
 * - Entitled without one: the include becomes a hard cap. This is what makes
 *   fixed-tier billing work on its own, before metered pricing is switched on.
 * - A period that no longer contains `now` (a renewal webhook that has not
 *   landed yet): roll the stored period forward by its own length, so a stale
 *   row can never produce an empty window and with it unlimited sending. This
 *   substitution is for entitlement only — see `meteringPeriodStart`.
 */
export function entitlementFrom(
  row: BillingSnapshot | undefined,
  now: Date,
): Entitlement {
  if (!row) return FREE_ENTITLEMENT(now);
  if (!isEntitledStatus(row.status)) return freeButManaged(row, now);
  // Cancelled, and the paid-for period is over. The provider keeps the status
  // `active` with `cancel_at_period_end` set right up to the boundary, so the
  // status cannot answer this — and if the revoke webhook is lost, dropped as
  // stale, or arrives while the team is unknown, nothing else ever will. The
  // window roll-forward below would otherwise hand this row a fresh allowance
  // every period for ever, uncapped when overage is enabled.
  if (row.cancelAtPeriodEnd && now.getTime() >= row.periodEnd.getTime())
    return freeButManaged(row, now);
  // The grace clock runs from the stamp when there is one. There need not be:
  // `order.paid` clears `pastDueAt` without touching `status`, so a row can
  // sit at `past_due` with no stamp — and treating that as an unstartable
  // clock would let a dead card send for ever. The period end is the honest
  // fallback: a subscription goes past due because the renewal was not paid.
  const graceFrom = row.pastDueAt ?? row.periodEnd;
  if (
    row.status === "past_due" &&
    now.getTime() >= graceFrom.getTime() + PAST_DUE_GRACE_MS
  )
    return freeButManaged(row, now);
  const window = currentWindow(row, now);
  return {
    plan: row.plan,
    status: row.status,
    includedEmails: row.includedEmails,
    overagePer1kCents: row.overagePer1kCents,
    overageEnabled: row.overageEnabled,
    monthlyCap: row.overageEnabled ? null : row.includedEmails,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    periodStart: window.start,
    periodEnd: window.end,
    managed: true,
    pastDueAt: row.pastDueAt,
  };
}

/**
 * The key a team's `billing_usage` row is stored under: the **stored**
 * `team_billing.period_start`, never the window `entitlementFrom` returned.
 *
 * Entitlement substitutes a rolled-forward window whenever the stored period
 * does not contain `now` — a renewal webhook that has not landed yet, a
 * non-entitling status. Keying usage off that would mean one metering run
 * keys on the provider period and the next on a window we invented: a second
 * row accumulates for hours the first already counted, the watermark resets
 * and the whole period is re-bucketed. The provider-side `externalId` dedupe
 * protects the invoice from that, not our numbers.
 */
export const meteringPeriodStart = (
  row: Pick<TeamBilling, "periodStart"> | undefined,
  now: Date,
): Date => row?.periodStart ?? calendarMonth(now).start;

/**
 * Whether the team already holds a subscription a second checkout would
 * duplicate — the exact condition `startCheckout` refuses on.
 *
 * It is a named, exported predicate rather than an inline `&&` because two
 * places have to agree on it: the service, which refuses, and the billing
 * page, which decides whether to offer a plan button at all. A UI computing
 * its own version of "already subscribed" drifts from the server's the first
 * time either is edited, and every way it can drift is bad — an offered
 * button that always errors, or a hidden one for a team that could have
 * bought. **This is not the enforcement**; the refusal in `startCheckout`
 * is, and it stays there whatever the UI renders.
 *
 * `subscriptionId` and not merely "a row exists": a row whose subscription
 * was canceled or never completed is `managed` (its portal still opens) but
 * has nothing for a new checkout to collide with, so that team may buy again.
 */
export const hasEntitlingSubscription = (
  row: Pick<TeamBilling, "subscriptionId" | "status"> | undefined,
): boolean => Boolean(row?.subscriptionId) && isEntitledStatus(row?.status);

/**
 * Whether a paid order is newer than the last one applied — the guard on
 * *clearing* the past-due grace clock.
 *
 * Pure and exported so the refusing branch is covered by a unit test with two
 * explicit dates: a provider fake that stamps every order with `now` can never
 * stage a replay of an older invoice, which is precisely the case that matters
 * (a late `order.paid` for last month's invoice, arriving after the
 * subscription has gone past due again, would otherwise buy another week of
 * paid caps on a dead card). Equal timestamps are *not* newer: the first
 * delivery already cleared the clock, so an exact replay has nothing to do.
 */
export const orderIsNewer = (
  paidAt: Date,
  lastOrderPaidAt: Date | null,
): boolean =>
  Number.isFinite(paidAt.getTime()) &&
  (lastOrderPaidAt === null || paidAt.getTime() > lastOrderPaidAt.getTime());

/** `team_billing` row for a team, or undefined. */
export async function billingRow(
  teamId: string,
  client: DbClient = db(),
): Promise<TeamBilling | undefined> {
  const [row] = await client
    .select()
    .from(teamBilling)
    .where(eq(teamBilling.teamId, teamId));
  return row;
}

/** The entitlement a team is on right now. */
export async function teamEntitlement(
  teamId: string,
  now = new Date(),
): Promise<Entitlement> {
  return entitlementFrom(await billingRow(teamId), now);
}
