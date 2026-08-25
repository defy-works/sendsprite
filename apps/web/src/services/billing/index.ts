import { and, eq, isNull, lt, lte, or } from "drizzle-orm";
import {
  can,
  FREE_PLAN_METADATA,
  isEntitledStatus,
  type BillingStateObject,
  type TeamRole,
} from "@sendsprite/shared";
import { db } from "@/db";
import { billingEvents, organization, teamBilling } from "@/db/schema";
import {
  computeDiff,
  recordAudit,
  type AuditInput,
  type RequestMeta,
} from "@/lib/audit";
import type { Result } from "@/lib/result";
import { billingConfig, type BillingConfig } from "./config";
import { createFakeProvider } from "./fake";
import {
  BillingUnavailableError,
  subscriptionDefect,
  type BillingProvider,
  type PlanProduct,
  type ProviderEvent,
  type ProviderSubscription,
} from "./provider";
import {
  billingRow,
  entitlementFrom,
  meteringPeriodStart,
  orderIsNewer,
  type DbClient,
} from "./plans";
import { countSentIn, usageRow } from "./usage";

/**
 * The provider for this instance, built once. `fake` is chosen by
 * `BILLING_PROVIDER` (refused in production by the env schema); Polar is
 * loaded lazily so `@polar-sh/sdk` is never pulled in with billing off.
 * Kept on `globalThis` for the same reason `db()` is: Next dev HMR
 * re-evaluates this module and would otherwise build a client per reload.
 *
 * The *promise* is memoised, not the provider, so two concurrent first
 * requests cannot each build one — and so both wait for `ready()`.
 */
const g = globalThis as { __sendspriteBilling?: Promise<BillingProvider> };

/** Constructs the configured implementation. Warming is `buildProvider`'s job. */
async function constructProvider(cfg: BillingConfig): Promise<BillingProvider> {
  if (cfg.provider === "fake") return createFakeProvider();
  const { createPolarProvider } = await import("./polar");
  return createPolarProvider({
    accessToken: cfg.accessToken!,
    webhookSecret: cfg.webhookSecret!,
    server: cfg.server,
    eventName: cfg.eventName,
    meterId: cfg.meterId,
  });
}

async function buildProvider(cfg: BillingConfig): Promise<BillingProvider> {
  const provider = await constructProvider(cfg);
  // Warms whatever the implementation needs before its first (synchronous)
  // `verifyWebhook`. For Polar that is the lazily-imported SDK: without this
  // the first delivery after every deploy is refused with "provider SDK not
  // loaded" — recoverable, since the provider retries, but it turns each
  // deploy into a burst of failed deliveries.
  //
  // Every provider goes through the same await, including the fake. A branch
  // that returns before it would let the fake diverge from production on
  // exactly the property this guarantees, and every later test written
  // against the fake would then be blind to a regression here.
  await provider.ready?.();
  return provider;
}

export function getBillingProvider(): Promise<BillingProvider> {
  const cfg = billingConfig();
  if (!cfg.enabled)
    return Promise.reject(
      new BillingUnavailableError("Billing is not enabled on this instance."),
    );
  if (!g.__sendspriteBilling) {
    const pending = buildProvider(cfg);
    g.__sendspriteBilling = pending;
    // A failed build must not be cached, or one unreachable import poisons the
    // process for its lifetime. The warming await lives *inside* `pending`, so
    // this covers a `ready()` rejection too — a provider that never warmed is
    // exactly the one that must not be handed to the next caller.
    void pending.catch(() => {
      if (g.__sendspriteBilling === pending) g.__sendspriteBilling = undefined;
    });
  }
  return g.__sendspriteBilling;
}

/** Drops the memoised provider (tests, and after an env change). */
export function resetBillingProvider(): void {
  g.__sendspriteBilling = undefined;
}

// ---------------------------------------------------------------- state

/** Everything the billing page renders, in one read. */
export async function teamBillingState(
  teamId: string,
  now = new Date(),
): Promise<BillingStateObject> {
  const cfg = billingConfig();
  const row = await billingRow(teamId);
  const e = entitlementFrom(row, now);
  const [used, usage] = await Promise.all([
    countSentIn(teamId, { start: e.periodStart, end: e.periodEnd }),
    // Deliberately *not* `e.periodStart`: the entitlement may have rolled the
    // stored period forward, and usage is keyed on the stored one.
    usageRow(teamId, meteringPeriodStart(row, now)),
  ]);
  return {
    enabled: cfg.enabled,
    plan: e.plan,
    status: e.status,
    includedEmails: e.includedEmails,
    overagePer1kCents: e.overagePer1kCents,
    overageEnabled: e.overageEnabled,
    cancelAtPeriodEnd: e.cancelAtPeriodEnd,
    periodStart: e.periodStart.toISOString(),
    periodEnd: e.periodEnd.toISOString(),
    used,
    reportedUnits: usage?.reportedUnits ?? 0,
    managed: e.managed,
    pastDueAt: e.pastDueAt?.toISOString() ?? null,
  };
}

// ------------------------------------------------------------- webhooks

export interface HandleResult {
  status: 200 | 403;
  applied: boolean;
  duplicate?: boolean;
  reason?: string;
}

/**
 * What applying an event decided. `audit` is handed back rather than written
 * on the spot: the audit write must not run on a second connection while the
 * apply transaction holds one (that is a pool deadlock under load), and a
 * rolled-back delivery must not leave an audit row describing a change that
 * never happened.
 */
interface ApplyOutcome {
  applied: boolean;
  reason?: string;
  audit?: AuditInput;
}

const teamExists = async (tx: DbClient, teamId: string): Promise<boolean> =>
  (
    await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, teamId))
      .limit(1)
  ).length > 0;

const eventTeamId = (e: ProviderEvent): string | null =>
  e.kind === "subscription"
    ? e.subscription.externalCustomerId
    : e.kind === "order_paid"
      ? e.externalCustomerId
      : null;

const eventObjectId = (e: ProviderEvent): string | null =>
  e.kind === "subscription"
    ? e.subscription.subscriptionId
    : e.kind === "order_paid"
      ? e.subscriptionId
      : null;

/**
 * Verify, deduplicate and apply one provider webhook.
 *
 * Idempotency is a primary-key conflict on `billing_events.id`, which is the
 * provider's delivery id (unique per delivery, reused on retries), so two
 * replicas racing on the same retry can only insert once and only the winner
 * applies. Nothing is recorded for a delivery that fails verification: an
 * unauthenticated caller must not be able to write rows.
 *
 * **The insert, the apply and the `applied_at` mark are one transaction.** Run
 * as separate statements they open a crash window: die between the insert and
 * the mark and the row exists — so every retry short-circuits as a duplicate —
 * for an event that was never applied, silently losing a subscription change.
 * A rolled-back delivery needs no recovery sweep: this throws, the route
 * answers non-2xx, the provider redelivers, and the dedupe key is free again.
 *
 * The response is 200 for any verified delivery, including one we choose not
 * to apply — a 4xx would make the provider retry something that can never
 * succeed.
 */
export async function handleProviderEvent(
  provider: BillingProvider,
  body: string,
  headers: Headers,
  now = new Date(),
): Promise<HandleResult> {
  const verified = provider.verifyWebhook(body, headers);
  if (!verified.ok) {
    console.warn("[billing] webhook rejected:", verified.reason);
    return { status: 403, applied: false, reason: verified.reason };
  }
  const event = verified.event;
  const outcome = await db().transaction(
    async (tx): Promise<ApplyOutcome & { duplicate?: boolean }> => {
      const inserted = await tx
        .insert(billingEvents)
        .values({
          id: event.deliveryId,
          teamId: eventTeamId(event),
          type: event.type,
          objectId: eventObjectId(event),
          payload: { type: event.type },
        })
        .onConflictDoNothing({ target: billingEvents.id })
        .returning({ id: billingEvents.id });
      if (inserted.length === 0) return { applied: false, duplicate: true };

      const applied = await apply(tx, provider.id, event, now);
      await tx
        .update(billingEvents)
        .set({
          appliedAt: applied.applied ? now : null,
          // A reason can accompany an *applied* event too: a delivery whose
          // status half applied while its plan half was withheld is neither
          // cleanly applied nor skipped, and the column is where that shows.
          skippedReason: applied.reason ?? null,
        })
        .where(eq(billingEvents.id, event.deliveryId));
      return applied;
    },
  );
  const { audit, ...result } = outcome;
  if (audit) await recordAudit(audit);
  return { status: 200, ...result };
}

async function apply(
  tx: DbClient,
  providerId: string,
  event: ProviderEvent,
  now: Date,
): Promise<ApplyOutcome> {
  if (event.kind === "ignored")
    return { applied: false, reason: "unmodelled_type" };
  if (event.kind === "order_paid") return applyOrderPaid(tx, event, now);
  return applySubscription(tx, providerId, event.subscription, event.type, now);
}

/**
 * A paid order clears the past-due grace clock — under two conditions.
 *
 * It must be an order **for the subscription we track**. A provider bills every
 * purchase the customer makes through the same customer record (Polar's
 * `billingReason: "purchase"` is a one-off product, not a renewal), so an
 * unrelated receipt would otherwise wipe the grace clock on a subscription
 * whose card is still dead.
 *
 * And it must be *newer* than the last order applied. A late or replayed
 * `order.paid` for an earlier invoice, arriving after the subscription has gone
 * `past_due` again, would otherwise reset the clock and buy another week of
 * paid caps.
 *
 * Both are re-stated in the `WHERE` of the write, not only checked against the
 * row that was read: two deliveries racing on one team would both pass a check
 * made against the same pre-read row.
 */
async function applyOrderPaid(
  tx: DbClient,
  event: Extract<ProviderEvent, { kind: "order_paid" }>,
  now: Date,
): Promise<ApplyOutcome> {
  const teamId = event.externalCustomerId;
  if (!teamId) return { applied: false, reason: "no_external_customer" };
  const before = await billingRow(teamId, tx);
  if (!before) return { applied: false, reason: "no_subscription" };
  // An order with no subscription id is a one-off purchase by construction.
  if (!event.subscriptionId || event.subscriptionId !== before.subscriptionId)
    return { applied: false, reason: "unrelated_order" };
  if (!orderIsNewer(event.paidAt, before.lastOrderPaidAt))
    return { applied: false, reason: "stale" };
  const updated = await tx
    .update(teamBilling)
    .set({ pastDueAt: null, lastOrderPaidAt: event.paidAt, updatedAt: now })
    .where(
      and(
        eq(teamBilling.teamId, teamId),
        eq(teamBilling.subscriptionId, event.subscriptionId),
        or(
          isNull(teamBilling.lastOrderPaidAt),
          lt(teamBilling.lastOrderPaidAt, event.paidAt),
        ),
      ),
    )
    .returning({ teamId: teamBilling.teamId });
  // Nothing matched: a concurrent delivery moved the row between the read and
  // the write, and what it wrote is at least as new as this.
  return updated.length
    ? { applied: true }
    : { applied: false, reason: "stale" };
}

const auditView = (
  row: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  if (!row) return {};
  const view: Record<string, unknown> = { ...row };
  for (const col of ["createdAt", "updatedAt", "providerModifiedAt"])
    delete view[col];
  return view;
};

/**
 * Columns every entitlement write must set. `onConflictDoUpdate({ set })`
 * takes a `Partial`, so an upsert that forgets `includedEmails` compiles and
 * silently leaves the previous plan's allowance behind across a plan change —
 * a Free allowance on a Scale customer. Naming them `Required` here is what
 * turns that into a compile error.
 */
type BillingUpsert = Required<
  Pick<
    typeof teamBilling.$inferInsert,
    | "plan"
    | "includedEmails"
    | "overagePer1kCents"
    | "status"
    | "periodStart"
    | "periodEnd"
    | "providerModifiedAt"
  >
> &
  Partial<typeof teamBilling.$inferInsert>;

/**
 * Write the entitlement snapshot for a subscription. Runs inside the webhook
 * transaction; the audit row it describes is returned, not written (see
 * `ApplyOutcome`).
 *
 * Out-of-order safety is one comparison: a payload whose `modifiedAt` is
 * older than what is stored is dropped. Same shape as the status ranking in
 * `services/email-events.ts` — never read-then-write a decision the payload
 * already carries.
 *
 * A product without our metadata resolves to the free plan rather than
 * throwing: an operator adding a bespoke product in the provider dashboard
 * must not be able to 500 the webhook endpoint. A product that *claims* one of
 * our plans but carries unusable fields is the opposite case — a configuration
 * fault, not a different product — so its plan fields are withheld and the
 * stored ones kept, rather than downgrading a paying customer on the strength
 * of a bad string. Only the plan fields: the status half of the same payload
 * is applied, or a revoked subscription on a typo'd product would keep its
 * paid caps until someone noticed the dashboard.
 */
export async function applySubscription(
  tx: DbClient,
  providerId: string,
  sub: ProviderSubscription,
  type: string,
  now = new Date(),
): Promise<ApplyOutcome> {
  const teamId = sub.externalCustomerId;
  if (!teamId) return { applied: false, reason: "no_external_customer" };
  // The seam promises a `ProviderSubscription`; it does not promise the
  // provider filled it in, and an `Invalid Date` reaches a timestamp column as
  // a thrown `RangeError` mid-transaction rather than a refusal anyone can
  // read. `subscriptionDefect` is the seam's own check, so every
  // implementation is held to it in the one place provider data becomes ours.
  const defect = subscriptionDefect(sub);
  if (defect) {
    console.warn(
      `[billing] unusable subscription payload for team ${teamId}: ${defect}`,
    );
    return { applied: false, reason: "malformed_payload" };
  }
  if (!(await teamExists(tx, teamId)))
    return { applied: false, reason: "unknown_team" };

  const before = await billingRow(teamId, tx);
  if (before && sub.modifiedAt.getTime() < before.providerModifiedAt.getTime())
    return { applied: false, reason: "stale" };

  // Plan resolution is what can fail here; the *status* cannot. Whether a
  // subscription is canceled, revoked, unpaid or past due is a fact the
  // payload carries on its own, and it does not become unknowable because
  // someone cleared a field on the product. So a product that claims one of
  // our plans with unusable metadata withholds only its plan fields — the
  // status, period and cancellation flag are applied as normal.
  const brokenPlan = !sub.plan && sub.claimsPlan;
  if (brokenPlan)
    // Loud on purpose: this is an operator error in the provider dashboard and
    // it freezes the plan half of every entitlement change on that product
    // until it is fixed.
    console.error(
      `[billing] product ${sub.productId} claims one of our plans but its metadata is unusable; ` +
        `team ${teamId} (subscription ${sub.subscriptionId}) keeps its stored plan while the ` +
        `status is applied. Fix the product's metadata in the provider dashboard.`,
    );
  if (brokenPlan && !before)
    // Nothing stored to keep and `included_emails` has no default, so there is
    // no honest row to write. The delivery is recorded and nothing changes;
    // there is no entitlement here to protect either way.
    return { applied: false, reason: "malformed_plan_metadata" };
  if (!sub.plan && !sub.claimsPlan)
    console.warn(
      `[billing] product ${sub.productId} carries no plan metadata; team ${teamId} treated as free`,
    );
  const meta = sub.plan ?? FREE_PLAN_METADATA;
  const planFields =
    brokenPlan && before
      ? {
          plan: before.plan,
          includedEmails: before.includedEmails,
          overagePer1kCents: before.overagePer1kCents,
        }
      : {
          plan: meta.plan,
          includedEmails: meta.includedEmails,
          overagePer1kCents: meta.overagePer1kCents,
        };

  const set: BillingUpsert = {
    provider: providerId,
    providerCustomerId: sub.customerId,
    subscriptionId: sub.subscriptionId,
    productId: sub.productId,
    ...planFields,
    status: sub.status,
    // Price-derived, not metadata-derived: it survives a broken product.
    overageEnabled: sub.hasMeteredPrice,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    periodStart: sub.currentPeriodStart,
    periodEnd: sub.currentPeriodEnd,
    providerModifiedAt: sub.modifiedAt,
    // The provider's own observation of when the charge failed wins: measuring
    // the grace window from our arrival time makes the deadline a function of
    // webhook uptime, so an outage hands every affected customer extra days.
    // A stamp already stored comes next (the clock must not restart on a
    // redelivery), and `now` is the last resort for a provider that does not
    // report one. `lastOrderPaidAt` is deliberately absent from this write: it
    // is the order stream's watermark and a subscription knows nothing of it.
    pastDueAt:
      sub.status === "past_due"
        ? (sub.pastDueAt ?? before?.pastDueAt ?? now)
        : null,
    // `$onUpdate` does not fire on an upsert.
    updatedAt: now,
  };
  // The ordering guard belongs in the write, not only in the read above.
  // `db()` runs at READ COMMITTED, and a provider emits several deliveries at
  // once on a plan change: two handlers can both read the pre-change row and
  // the later commit then wins with values computed from a stale read —
  // `canceled` overwriting `active` and blocking a paying customer. Restating
  // it as `setWhere` makes the database refuse that write.
  //
  // `lte`, not `lt`: two deliveries from one provider transaction share a
  // `modified_at`, and they describe the same object state, so ties keep the
  // arrival-order behaviour the pre-read check has always had. Only a payload
  // strictly older than what is stored is refused.
  const [after] = await tx
    .insert(teamBilling)
    .values({ teamId, ...set })
    .onConflictDoUpdate({
      target: teamBilling.teamId,
      set,
      setWhere: lte(teamBilling.providerModifiedAt, sub.modifiedAt),
    })
    .returning();
  // No row came back: the conflicting row is newer than this payload, so a
  // concurrent delivery has already applied something later. Not an error —
  // the same answer the pre-read check gives when it wins the race.
  if (!after) return { applied: false, reason: "stale" };

  return {
    applied: true,
    // Applied, but only half of it: the reason is still recorded on the
    // delivery so a partial apply is visible without reading the logs.
    ...(brokenPlan && { reason: "malformed_plan_metadata_status_only" }),
    audit: {
      teamId,
      actorUserId: null,
      // Audit action convention: `<resource>.<verb>` (Phase 4 opener 8).
      action: `billing.${type}`,
      targetType: "subscription",
      targetId: sub.subscriptionId,
      diff: computeDiff(auditView(before), auditView(after)),
    },
  };
}

// ------------------------------------------------------- checkout/portal

/**
 * The slice of the team context billing mutations need. `role` is not
 * optional: a caller that cannot say who is acting cannot be allowed to buy,
 * and making the gate a property of the actor is what keeps the check at the
 * service seam rather than in one particular UI.
 */
export interface BillingActor {
  teamId: string;
  userId: string;
  role: TeamRole;
  /** Prefills the provider's checkout form when we know it. */
  email?: string;
  /** Client ip / UA for the audit row; absent outside a request. */
  meta?: RequestMeta;
}

const DENIED: Result<never> = {
  ok: false,
  code: "forbidden",
  error: "You don't have permission to do that.",
};

const DISABLED: Result<never> = {
  ok: false,
  code: "not_configured",
  error: "Billing is not enabled on this instance.",
};

/**
 * A provider that cannot be built or reached is an operator problem, not a
 * customer one, and it deserves its own answer: `not_configured` is a 503 the
 * caller can render as "come back later", where the generic `internal_error`
 * reads as "your click was wrong". The provider's own message is logged, not
 * shown — it names environment variables the person clicking cannot fix.
 */
const UNAVAILABLE: Result<never> = {
  ok: false,
  code: "not_configured",
  error:
    "Billing is unavailable: the payment provider is not configured correctly on this instance. Please contact support.",
};

/**
 * The provider's own words about why it is unusable, for the one person who
 * can act on them.
 *
 * On a self-hosted or single-operator instance the person clicking "Manage
 * billing" is often the person who set `POLAR_ACCESS_TOKEN`, and telling them
 * "contact support" when the answer is "that variable is empty" wastes the
 * only diagnosis they could have made themselves. So the detail is attached —
 * but only for `instance.manage`, which is owner-only and is exactly the
 * permission to change the configuration being complained about.
 *
 * It is deliberately **not** folded into `error`: that string is what a
 * customer reads, it must stay stable, and keeping the two apart means a
 * renderer cannot leak the diagnostic by accident. Truncated because a
 * provider SDK can throw a whole response body, and capped exposure to an
 * owner is still exposure.
 */
const OPERATOR_DETAIL_MAX = 300;

export const operatorDetail = (e: unknown): string =>
  (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(
    0,
    OPERATOR_DETAIL_MAX,
  );

const providerFailure = (
  what: string,
  e: unknown,
  fallback: Result<never>,
  role: TeamRole,
): Result<never> => {
  console.error(`[billing] ${what} failed`, e);
  if (!(e instanceof BillingUnavailableError)) return fallback;
  return can(role, "instance.manage")
    ? { ...UNAVAILABLE, details: { providerDetail: operatorDetail(e) } }
    : UNAVAILABLE;
};

/**
 * Provider checkout URL for a plan, or a typed refusal.
 *
 * The caller names a **plan**, never a product id: the id is resolved from the
 * provider's own catalog, so a hand-crafted form post cannot subscribe a team
 * to an arbitrary product. `provider` is the same injection seam
 * `handleProviderEvent` takes as its first argument — production passes
 * nothing and gets the configured one.
 */
export async function startCheckout(
  actor: BillingActor,
  plan: string,
  provider?: BillingProvider,
): Promise<Result<{ url: string }>> {
  const cfg = billingConfig();
  if (!cfg.enabled) return DISABLED;
  if (!can(actor.role, "billing.manage")) return DENIED;
  // A second checkout does not replace the first: the provider happily opens
  // another subscription for the same customer and bills both, while
  // `team_billing` holds one row per team — so the two then fight over it and
  // whichever webhook lands last decides what the customer is paying for.
  // Plan changes belong in the portal, which changes the existing
  // subscription in place and prorates it.
  const existing = await billingRow(actor.teamId);
  if (existing?.subscriptionId && isEntitledStatus(existing.status))
    return {
      ok: false,
      code: "conflict",
      error:
        "This team already has a subscription. Use the billing portal to change plan.",
    };
  try {
    const p = provider ?? (await getBillingProvider());
    const product = (await p.listPlanProducts()).find((x) => x.plan === plan);
    if (!product)
      return {
        ok: false,
        error: `No product for plan "${plan}".`,
        code: "not_found",
      };
    const { url } = await p.createCheckout({
      productId: product.productId,
      externalCustomerId: actor.teamId,
      ...(actor.email && { customerEmail: actor.email }),
      successUrl: cfg.successUrl,
    });
    await recordAudit({
      teamId: actor.teamId,
      actorUserId: actor.userId,
      ...actor.meta,
      action: "billing.checkout",
      targetType: "plan",
      targetId: plan,
    });
    return { ok: true, data: { url } };
  } catch (e) {
    return providerFailure(
      "checkout",
      e,
      {
        ok: false,
        error: "Could not start checkout. Please try again.",
        code: "internal_error",
      },
      actor.role,
    );
  }
}

/** Provider customer-portal URL, or a typed refusal. */
export async function openPortal(
  actor: BillingActor,
  provider?: BillingProvider,
): Promise<Result<{ url: string }>> {
  const cfg = billingConfig();
  if (!cfg.enabled) return DISABLED;
  if (!can(actor.role, "billing.manage")) return DENIED;
  const row = await billingRow(actor.teamId);
  if (!row?.providerCustomerId)
    return {
      ok: false,
      error: "This team has no subscription to manage yet.",
      code: "not_found",
    };
  try {
    const p = provider ?? (await getBillingProvider());
    const { url } = await p.createPortalSession({
      externalCustomerId: actor.teamId,
      returnUrl: cfg.returnUrl,
    });
    await recordAudit({
      teamId: actor.teamId,
      actorUserId: actor.userId,
      ...actor.meta,
      action: "billing.portal",
      targetType: "subscription",
      targetId: row.subscriptionId ?? actor.teamId,
    });
    return { ok: true, data: { url } };
  } catch (e) {
    return providerFailure(
      "portal",
      e,
      {
        ok: false,
        error: "Could not open the billing portal. Please try again.",
        code: "internal_error",
      },
      actor.role,
    );
  }
}

/**
 * The catalog for the upgrade UI. Never throws: a provider outage must leave
 * the billing page renderable — the team's plan and usage come from our own
 * tables and are still true.
 *
 * `error` carries the same operator-only diagnostic `providerFailure` attaches
 * to a refused action, for the same reason: an owner staring at an empty Plans
 * grid is usually looking at the *first* symptom of a misconfiguration, and
 * "try again in a moment" is a lie when the token is empty. **The caller is
 * responsible for showing it only to `instance.manage`** — it is returned
 * unconditionally because this function has no actor.
 */
export interface PlanCatalog {
  products: PlanProduct[];
  /** Why `products` is empty, for an instance owner. Null when it is not. */
  error: string | null;
}

export async function planCatalog(): Promise<PlanCatalog> {
  if (!billingConfig().enabled) return { products: [], error: null };
  try {
    const products = await (await getBillingProvider()).listPlanProducts();
    return { products, error: null };
  } catch (e) {
    console.error("[billing] catalog unavailable", e);
    return { products: [], error: operatorDetail(e) };
  }
}

export { entitlementFrom, teamEntitlement } from "./plans";
export type { Entitlement } from "./plans";
