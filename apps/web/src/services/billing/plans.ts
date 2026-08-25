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
 * - Entitled with a metered price: no monthly cap. The customer has agreed to
 *   pay for the excess and blocking their sending would be the wrong failure.
 * - Entitled without one: the include becomes a hard cap. This is what makes
 *   fixed-tier billing work on its own, before metered pricing is switched on.
 * - A period that no longer contains `now` (a renewal webhook that never
 *   arrived): fall back to the UTC month, so a stale row can never produce an
 *   empty window and with it unlimited sending. This substitution is for
 *   entitlement only — see `meteringPeriodStart`.
 */
export function entitlementFrom(
  row: BillingSnapshot | undefined,
  now: Date,
): Entitlement {
  if (!row) return FREE_ENTITLEMENT(now);
  if (!isEntitledStatus(row.status)) return freeButManaged(row, now);
  // A past_due row with no stamp has no clock to run out: the webhook handler
  // stamps every transition into past_due, so this is a row written before
  // that existed, and downgrading it silently would be the worse guess.
  if (
    row.status === "past_due" &&
    row.pastDueAt &&
    now.getTime() >= row.pastDueAt.getTime() + PAST_DUE_GRACE_MS
  )
    return freeButManaged(row, now);
  const fresh =
    row.periodStart.getTime() <= now.getTime() &&
    now.getTime() < row.periodEnd.getTime();
  const window = fresh
    ? { start: row.periodStart, end: row.periodEnd }
    : calendarMonth(now);
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
 * Entitlement substitutes the calendar month whenever the stored period does
 * not contain `now` — a renewal webhook that has not landed yet, a
 * non-entitling status. Keying usage off that would mean one metering run
 * keys on the provider period and the next on the calendar month: a second
 * row accumulates for hours the first already counted, the watermark resets
 * and the whole period is re-bucketed. The provider-side `externalId` dedupe
 * protects the invoice from that, not our numbers.
 */
export const meteringPeriodStart = (
  row: Pick<TeamBilling, "periodStart"> | undefined,
  now: Date,
): Date => row?.periodStart ?? calendarMonth(now).start;

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
