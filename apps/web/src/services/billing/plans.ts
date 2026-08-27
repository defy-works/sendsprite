import { eq } from "drizzle-orm";
import {
  FREE_PLAN_METADATA,
  isEntitledStatus,
  isGrantedPlan,
  type EntitlementSource,
  type GrantedPlan,
  type Plan,
} from "@sendsprite/shared";
import { db, type Db } from "@/db";
import { teamBilling, teamSettings, type TeamBilling } from "@/db/schema";
import { CATALOG_TTL_MS, cachedPlanIncluded } from "./catalog-cache";
import { billingConfig } from "./config";
import type { PlanProduct } from "./provider";

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
  plan: GrantedPlan;
  status: string | null;
  /** Null on an unlimited grant. */
  includedEmails: number | null;
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
  /** Which of grant, subscription or instance default produced this. */
  source: EntitlementSource;
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
    source: "default",
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
 *
 * The `source` on the result is meaningful only to `resolveEntitlement`, the
 * one caller that reads it: `subscription` means the row was honoured, and
 * `default` means this function fell back to Free caps for any of the reasons
 * above. It is *not* a claim about where the team's entitlement finally came
 * from — `resolveEntitlement` decides that.
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
    source: "subscription",
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

/** The grant an entitlement is built from. */
export interface Grant {
  plan: GrantedPlan;
  /** Null on an unlimited grant. */
  includedEmails: number | null;
  source: Exclude<EntitlementSource, "subscription">;
  /**
   * The caller's, not derived from `plan`: a granted team that also holds a
   * subscription row must keep its customer portal reachable.
   */
  managed: boolean;
}

/**
 * An entitlement that did not come from a subscription: an operator grant or
 * the instance default. Calendar month, hard cap at the include (none for
 * `unlimited`), nothing billed.
 */
export function grantedEntitlement(
  { plan, includedEmails, source, managed }: Grant,
  now: Date,
): Entitlement {
  const w = calendarMonth(now);
  return {
    plan,
    status: null,
    includedEmails,
    overagePer1kCents: 0,
    overageEnabled: false,
    monthlyCap: includedEmails,
    cancelAtPeriodEnd: false,
    periodStart: w.start,
    periodEnd: w.end,
    managed,
    source,
    pastDueAt: null,
  };
}

export interface EntitlementInputs {
  /** `team_settings.plan_override`, or null. */
  override: string | null;
  row: BillingSnapshot | undefined;
  defaultPlan: GrantedPlan;
  /** Included emails for a catalog plan, undefined when unknown. */
  catalog: (plan: Plan) => Promise<number | undefined>;
}

/**
 * One line per `key` per catalog TTL.
 *
 * Entitlement is resolved on every send, so an unthrottled `console.error`
 * below would be a line per send for as long as the misconfiguration lasts —
 * enough to bury the rest of the log, and to cost real money in an aggregator.
 * `CATALOG_TTL_MS` is the window because that is the soonest a catalog refresh
 * could have made the message untrue; repeating faster tells an operator
 * nothing new. Deliberately not reset between tests: it is a log throttle, and
 * nothing asserts on it.
 */
const loggedAt = new Map<string, number>();
function logThrottled(key: string, message: string): void {
  const at = Date.now();
  const last = loggedAt.get(key);
  if (last !== undefined && at - last < CATALOG_TTL_MS) return;
  loggedAt.set(key, at);
  console.error(message);
}

/**
 * Included volume for a granted plan; Free's when the catalog cannot say.
 *
 * Falling back to Free caps rather than refusing keeps a catalog outage from
 * turning a grant into a send failure. It does leave the team with a refusal
 * message naming the granted plan over a cap that is Free's, which reads as a
 * contradiction — hence the log: the operator, not the customer, is the one
 * who can fix it.
 */
async function grantedInclude(
  plan: GrantedPlan,
  catalog: EntitlementInputs["catalog"],
): Promise<number | null> {
  if (plan === "unlimited") return null;
  if (plan === "free") return FREE_PLAN_METADATA.includedEmails;
  const n = await catalog(plan);
  if (n === undefined) {
    logThrottled(
      `no-catalog-plan:${plan}`,
      `[billing] catalog has no "${plan}"; granting the Free allowance instead`,
    );
    return FREE_PLAN_METADATA.includedEmails;
  }
  return n;
}

/**
 * The one precedence for "what is this team entitled to":
 * operator grant → entitling subscription → `DEFAULT_PLAN`.
 *
 * Pure apart from `catalog`, so the matrix is unit-tested. The numeric
 * `team_settings` limits are *not* here: they are caps, not plans, and
 * `resolveTeamCaps` applies them on top, column by column.
 *
 * "Entitling subscription" is read off `entitlementFrom`'s `source`: it says
 * `subscription` only when it honoured the row, and `default` whenever it fell
 * back to Free caps (no row, non-entitling status, lapsed cancellation, expired
 * grace) — exactly the cases the instance default is for. The row's status,
 * cancellation and past-due stamp are carried onto the default so the banner
 * can still say why.
 */
export async function resolveEntitlement(
  inp: EntitlementInputs,
  now: Date,
): Promise<Entitlement> {
  const managed = inp.row !== undefined;
  if (inp.override) {
    if (isGrantedPlan(inp.override))
      return grantedEntitlement(
        {
          plan: inp.override,
          includedEmails: await grantedInclude(inp.override, inp.catalog),
          source: "override",
          managed,
        },
        now,
      );
    // Falls through: a stored grant nobody can honour — a plan dropped from
    // `GRANTABLE_PLANS` since it was written, or a value put there by hand.
    // Ignored rather than thrown on, because an unusable grant must not stop a
    // team sending, but named in the log: silence is how it stays wrong.
    logThrottled(
      `bad-override:${inp.override}`,
      `[billing] team_settings.plan_override is "${inp.override}", which is not a grantable plan; ignoring the grant`,
    );
  }
  const sub = entitlementFrom(inp.row, now);
  if (sub.source === "subscription") return sub;
  const d = grantedEntitlement(
    {
      plan: inp.defaultPlan,
      includedEmails: await grantedInclude(inp.defaultPlan, inp.catalog),
      source: "default",
      managed,
    },
    now,
  );
  return managed
    ? {
        ...d,
        status: sub.status,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        pastDueAt: sub.pastDueAt,
      }
    : d;
}

export type CatalogLoader = () => Promise<PlanProduct[]>;

/**
 * The wiring every entitlement read shares: the instance default, and the
 * catalog behind the process-wide cache.
 *
 * `loadCatalog` is a parameter only so this module never imports `./index`,
 * which imports this one. **Every caller must pass the same loader** —
 * `defaultCatalogLoader` — because the cache behind `cachedPlanIncluded` is a
 * module-level singleton, and a second loader would refresh that one slot with
 * a different source.
 */
export function entitlementInputs(
  override: string | null,
  row: BillingSnapshot | undefined,
  loadCatalog: CatalogLoader,
): EntitlementInputs {
  return {
    override,
    row,
    defaultPlan: billingConfig().defaultPlan,
    catalog: (plan) => cachedPlanIncluded(plan, loadCatalog),
  };
}

/**
 * The entitlement a team is on right now — grant, subscription or default.
 *
 * The catalog loader is a parameter rather than an import so `plans.ts` never
 * reaches into `./index`, which imports this module.
 *
 * `opts.row` is for a caller that has already read `team_billing` and needs it
 * for something else as well (`teamBillingState` keys usage off it): handing it
 * over saves a second read of the same row. `resolveTeamCaps` does not use this
 * wrapper at all — it folds both reads into the query it was already making.
 */
export async function teamEntitlement(
  teamId: string,
  now: Date,
  loadCatalog: CatalogLoader,
  opts: { row?: BillingSnapshot | undefined; client?: DbClient } = {},
): Promise<Entitlement> {
  const client = opts.client ?? db();
  const [[settings], row] = await Promise.all([
    client
      .select({ override: teamSettings.planOverride })
      .from(teamSettings)
      .where(eq(teamSettings.teamId, teamId)),
    // `"row" in opts`, not `opts.row ?? …`: `undefined` is a real answer here
    // (the team has no subscription), and reading it as "not supplied" would
    // re-read the row for exactly the teams that have none.
    "row" in opts ? opts.row : billingRow(teamId, client),
  ]);
  return resolveEntitlement(
    entitlementInputs(settings?.override ?? null, row, loadCatalog),
    now,
  );
}
