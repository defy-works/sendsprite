import { eq } from "drizzle-orm";
import {
  FREE_PLAN_METADATA,
  type BillingStateObject,
} from "@sendsprite/shared";
import { db } from "@/db";
import { billingEvents, organization, teamBilling } from "@/db/schema";
import { computeDiff, recordAudit, type AuditInput } from "@/lib/audit";
import type { Result } from "@/lib/result";
import { billingConfig, type BillingConfig } from "./config";
import { createFakeProvider } from "./fake";
import {
  BillingUnavailableError,
  type BillingProvider,
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

async function buildProvider(cfg: BillingConfig): Promise<BillingProvider> {
  if (cfg.provider === "fake") return createFakeProvider();
  const { createPolarProvider } = await import("./polar");
  const provider = createPolarProvider({
    accessToken: cfg.accessToken!,
    webhookSecret: cfg.webhookSecret!,
    server: cfg.server,
    eventName: cfg.eventName,
    meterId: cfg.meterId,
  });
  // Warms the lazily-imported SDK so the synchronous `verifyWebhook` is never
  // cold. Without it the first delivery after every deploy is refused with
  // "provider SDK not loaded" — recoverable, since the provider retries, but
  // it turns each deploy into a burst of failed deliveries.
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
    // process for its lifetime.
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
    // Deliberately *not* `e.periodStart`: the entitlement may have substituted
    // the calendar month, and usage is keyed on the stored period.
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
 * A paid order clears the past-due grace clock — but only when it is *newer*
 * than the last order applied. A late or replayed `order.paid` for an earlier
 * invoice, arriving after the subscription has gone `past_due` again, would
 * otherwise reset the clock and buy another week of paid caps on a dead card.
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
  if (!orderIsNewer(event.paidAt, before.lastOrderPaidAt))
    return { applied: false, reason: "stale" };
  await tx
    .update(teamBilling)
    .set({ pastDueAt: null, lastOrderPaidAt: event.paidAt, updatedAt: now })
    .where(eq(teamBilling.teamId, teamId));
  return { applied: true };
}

/**
 * Whether a normalised subscription is unusable as a database write.
 *
 * The seam promises a `ProviderSubscription`; it does not promise the provider
 * filled it in. An implementation that trusts a payload's shape can hand back
 * an `Invalid Date` or a missing id, and those reach `timestamp` and `text`
 * columns as a thrown `RangeError` mid-transaction (or, worse, a row whose
 * period is meaningless) rather than a refusal we can record. Checked here,
 * once, at the only place provider data becomes our data — a per-provider
 * guard would have to be written again for every implementation and would be
 * forgotten by one of them.
 */
const malformed = (sub: ProviderSubscription): boolean =>
  !sub.subscriptionId ||
  typeof sub.status !== "string" ||
  sub.status === "" ||
  !Number.isFinite(sub.currentPeriodStart?.getTime()) ||
  !Number.isFinite(sub.currentPeriodEnd?.getTime()) ||
  !Number.isFinite(sub.modifiedAt?.getTime());

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
  if (malformed(sub)) return { applied: false, reason: "malformed_payload" };
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
    // Stamped on the transition into past_due, cleared by a newer order.paid.
    // `lastOrderPaidAt` is deliberately absent: it is the order stream's
    // watermark and a subscription payload knows nothing about it.
    pastDueAt: sub.status === "past_due" ? (before?.pastDueAt ?? now) : null,
    // `$onUpdate` does not fire on an upsert.
    updatedAt: now,
  };
  const [after] = await tx
    .insert(teamBilling)
    .values({ teamId, ...set })
    .onConflictDoUpdate({ target: teamBilling.teamId, set })
    .returning();
  if (!after) throw new Error("team_billing upsert returned no row");

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

/** Provider checkout URL for a plan, or a typed refusal. */
export async function startCheckout(
  actor: { teamId: string; userId: string; email?: string },
  plan: string,
): Promise<Result<{ url: string }>> {
  const cfg = billingConfig();
  if (!cfg.enabled)
    return {
      ok: false,
      error: "Billing is not enabled.",
      code: "not_configured",
    };
  try {
    const provider = await getBillingProvider();
    const product = (await provider.listPlanProducts()).find(
      (p) => p.plan === plan,
    );
    if (!product)
      return {
        ok: false,
        error: `No product for plan "${plan}".`,
        code: "not_found",
      };
    const { url } = await provider.createCheckout({
      productId: product.productId,
      externalCustomerId: actor.teamId,
      ...(actor.email && { customerEmail: actor.email }),
      successUrl: cfg.successUrl,
    });
    await recordAudit({
      teamId: actor.teamId,
      actorUserId: actor.userId,
      action: "billing.checkout",
      targetType: "plan",
      targetId: plan,
    });
    return { ok: true, data: { url } };
  } catch (e) {
    console.error("[billing] checkout failed", e);
    return {
      ok: false,
      error: "Could not start checkout. Please try again.",
      code: "internal_error",
    };
  }
}

/** Provider customer-portal URL, or a typed refusal. */
export async function openPortal(actor: {
  teamId: string;
  userId: string;
}): Promise<Result<{ url: string }>> {
  const cfg = billingConfig();
  if (!cfg.enabled)
    return {
      ok: false,
      error: "Billing is not enabled.",
      code: "not_configured",
    };
  const row = await billingRow(actor.teamId);
  if (!row?.providerCustomerId)
    return {
      ok: false,
      error: "This team has no subscription to manage yet.",
      code: "not_found",
    };
  try {
    const provider = await getBillingProvider();
    const { url } = await provider.createPortalSession({
      externalCustomerId: actor.teamId,
      returnUrl: cfg.returnUrl,
    });
    await recordAudit({
      teamId: actor.teamId,
      actorUserId: actor.userId,
      action: "billing.portal",
      targetType: "subscription",
      targetId: row.subscriptionId ?? actor.teamId,
    });
    return { ok: true, data: { url } };
  } catch (e) {
    console.error("[billing] portal failed", e);
    return {
      ok: false,
      error: "Could not open the billing portal. Please try again.",
      code: "internal_error",
    };
  }
}

/** The catalog for the upgrade UI; empty when billing is off or unreachable. */
export async function planCatalog() {
  if (!billingConfig().enabled) return [];
  try {
    return await (await getBillingProvider()).listPlanProducts();
  } catch (e) {
    console.error("[billing] catalog unavailable", e);
    return [];
  }
}

export { entitlementFrom, teamEntitlement } from "./plans";
export type { Entitlement } from "./plans";
