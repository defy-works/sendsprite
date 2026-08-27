"use client";
import { useState, useTransition } from "react";
import type { BillingStateObject } from "@sendsprite/shared";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { checkout, portal, type Result } from "./actions";

export interface CatalogEntry {
  plan: string;
  name: string;
  priceCents: number;
  includedEmails: number;
  overagePer1kCents: number;
}

/** A failed payment, with the grace window resolved on the server. */
export interface PastDueNotice {
  /**
   * ISO instant the grace window closes, or null when the row carries no
   * `pastDueAt` to run a clock from. The warning is still worth showing; the
   * deadline is the part we would be inventing.
   */
  deadline: string | null;
  /** It has already closed: this team is on Free caps right now. */
  expired: boolean;
}

// Locale and time zone are pinned, so these render identically on the server
// and in the browser. An unpinned `toLocaleString` in a client component would
// hydrate differently from the SSR markup (see settings/page.tsx).
const n = (v: number) => v.toLocaleString("en-US");
const day = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));

/** `0 → Free`, `1200 → $12`, `40 → $0.40`. Cents only where there are cents. */
const money = (cents: number) =>
  cents === 0
    ? "Free"
    : cents % 100 === 0
      ? `$${n(cents / 100)}`
      : `$${(cents / 100).toFixed(2)}`;

const BANNER = "rounded-md border px-3 py-2 text-sm [&>strong]:font-semibold";
const AMBER = "border-amber-400/30 bg-amber-400/10 text-amber-200";
const RED = "border-red-400/30 bg-red-400/10 text-red-200";

/**
 * Amber from 80 % of the allowance, red at or past it — but only where the
 * allowance is a wall. With overage billed, being past the include is the
 * plan working as sold, not a problem, so it stays indigo.
 */
function barTone(used: number, included: number, metered: boolean) {
  if (metered) return "bg-indigo-400";
  const r = used / Math.max(1, included);
  return r >= 1 ? "bg-danger" : r >= 0.8 ? "bg-warning" : "bg-indigo-400";
}

/**
 * The operator-only diagnostic a refused billing action may carry. It rides in
 * `details` rather than `error` precisely so that reading it is a deliberate
 * act; the service only attaches it for `instance.manage`.
 */
const detailOf = (res: Result<unknown>): string | null => {
  if (res.ok) return null;
  const d = res.details as { providerDetail?: unknown } | undefined;
  return typeof d?.providerDetail === "string" ? d.providerDetail : null;
};

export function BillingPanel({
  state,
  catalog,
  canManage,
  subscribed,
  pastDue,
  daysLeft,
  showReported,
  providerDetail,
}: {
  state: BillingStateObject;
  catalog: CatalogEntry[];
  canManage: boolean;
  /**
   * The team holds a subscription a second checkout would duplicate, so
   * `startCheckout` refuses every plan. The catalogue routes to the portal
   * instead of offering a button that can only produce that refusal — see
   * `hasEntitlingSubscription`, which is where the condition is defined.
   */
  subscribed: boolean;
  pastDue: PastDueNotice | null;
  daysLeft: number;
  /** The watermark row covers the same period as `used`; see the page. */
  showReported: boolean;
  providerDetail: string | null;
}) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  // The provider's checkout and portal live on another origin, so the action
  // returns a URL and the browser navigates; a server-side redirect would
  // throw the typed refusal away. `busy` stays set on success — the page is
  // leaving, and a button that snaps back to idle mid-navigation reads as a
  // click that did nothing.
  const go = (key: string, fn: () => Promise<Result<{ url: string }>>) =>
    start(async () => {
      setBusy(key);
      setError(null);
      setDetail(null);
      try {
        const res = await fn();
        if (res.ok) {
          window.location.href = res.data.url;
          return;
        }
        setError(res.error);
        setDetail(detailOf(res));
      } catch {
        setError("Something went wrong. Please try again.");
      }
      setBusy(null);
    });

  /*
   * `includedEmails` is null on an unlimited entitlement — an operator grant
   * or a `DEFAULT_PLAN=unlimited` instance. Everything that draws a bar or
   * counts an overage is meaningless there, so the allowance is read once and
   * the null is branched on rather than coerced: `Math.max(1, null)` is 1, and
   * a team with no cap would have shown a full red bar.
   */
  const included = state.includedEmails;
  const unlimited = included === null;
  /** The team's plan was handed to it by the operator, not bought. */
  const granted = state.source === "override";
  /*
   * Nothing on this page can be bought. Either an operator granted the plan,
   * or the instance hands every team unlimited sending by `DEFAULT_PLAN` — and
   * in that second case a catalogue of paid tiers would be offering a customer
   * a downgrade dressed as an upgrade.
   */
  const nothingToBuy = granted || (state.source === "default" && unlimited);

  const over = unlimited ? 0 : Math.max(0, state.used - included);
  const pct = unlimited
    ? 0
    : Math.min(100, (state.used / Math.max(1, included)) * 100);
  const resets =
    daysLeft === 0
      ? "Resets today"
      : daysLeft === 1
        ? "Resets tomorrow"
        : `Resets in ${n(daysLeft)} days`;

  return (
    <>
      {pastDue && (
        <p role="alert" className={cn(BANNER, pastDue.expired ? RED : AMBER)}>
          <strong>Payment failed.</strong>{" "}
          {pastDue.expired ? (
            <>
              The grace period{" "}
              {pastDue.deadline ? `ended on ${day(pastDue.deadline)}` : "ended"}
              , so this team is now{" "}
              {unlimited
                ? "on this instance's own plan, which has no monthly cap,"
                : `held to ${n(included)} emails a month`}{" "}
              even though the subscription is still open. Update your payment
              method in the billing portal to restore your plan.
            </>
          ) : pastDue.deadline ? (
            <>
              Your plan keeps working until {day(pastDue.deadline)} while the
              charge is retried. After that this team drops to the Free
              plan&apos;s limits. Update your payment method in the billing
              portal before then.
            </>
          ) : (
            <>
              Your plan keeps working while the charge is retried, but not
              indefinitely. Update your payment method in the billing portal.
            </>
          )}
        </p>
      )}
      {state.cancelAtPeriodEnd && (
        <p role="alert" className={cn(BANNER, AMBER)}>
          <strong>Subscription ending.</strong> Your plan runs until{" "}
          {day(state.periodEnd)}. After that this team returns to the Free plan.
        </p>
      )}
      {providerDetail && (
        <p role="alert" className={cn(BANNER, AMBER)}>
          <strong>Payment provider unreachable.</strong> The plan catalogue
          could not be loaded, so no plan can be bought or changed until this is
          fixed. Only instance owners see this message.{" "}
          <span className="font-mono text-xs break-all opacity-80">
            {providerDetail}
          </span>
        </p>
      )}

      <Card className="flex flex-col">
        <CardHeader>
          <CardTitle>Your plan</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={state.plan === "free" ? "muted" : "indigo"}>
              {state.plan}
            </Badge>
            {state.status && state.status !== "active" && (
              <Badge
                variant={state.status === "past_due" ? "warning" : "muted"}
              >
                {state.status.replace(/_/g, " ")}
              </Badge>
            )}
            {/* Where the plan came from, said plainly. A team on Pro without
                ever having paid for it should not have to guess why. */}
            {granted && <Badge variant="muted">Operator grant</Badge>}
            {state.source === "default" && state.plan !== "free" && (
              <Badge variant="muted">Instance default</Badge>
            )}
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-5">
          <div className="flex flex-col gap-3">
            <p className="num-stamp">
              Emails this period · {day(state.periodStart)} –{" "}
              {day(state.periodEnd)}
            </p>
            <div className="flex flex-wrap items-baseline gap-x-3">
              <p className="metric-xl">{n(state.used)}</p>
              <p className="text-sm text-white/50">
                {unlimited ? "no monthly cap" : `of ${n(included)} included`}
              </p>
            </div>
            {/* No bar without a wall to draw it against. */}
            {!unlimited && (
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
                role="progressbar"
                aria-valuenow={Math.min(state.used, included)}
                aria-valuemin={0}
                aria-valuemax={included}
                aria-valuetext={`${n(state.used)} of ${n(included)} included emails`}
                aria-label="Emails used this period"
              >
                <div
                  className={cn(
                    "h-full transition-[width] duration-[var(--duration-slow)]",
                    barTone(state.used, included, state.overageEnabled),
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
              <p className="text-white/65">
                {unlimited ? (
                  <>There is no monthly cap on this plan.</>
                ) : state.overageEnabled ? (
                  <>
                    Past the include, sending continues at{" "}
                    {money(state.overagePer1kCents)} per 1,000.
                    {over > 0 && ` ${n(over)} over so far this period.`}
                  </>
                ) : (
                  <>Sending is capped at the included volume on this plan.</>
                )}
              </p>
              <p className="text-white/45">
                {resets} · {day(state.periodEnd)}
              </p>
            </div>
            {showReported && state.reportedUnits > 0 && (
              <p className="text-xs text-white/40">
                {n(state.reportedUnits)} reported to the payment provider so
                far. The figure above is read live from your email log, so it is
                the current one.
              </p>
            )}
          </div>

          <div className="hairline" aria-hidden />

          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* A control a member could never use is absent, not disabled: a
                greyed-out row of buttons teaches nothing. The sentence that
                replaces it says who to ask. */}
            {!canManage ? (
              <p className="text-sm text-white/50">
                Only owners and admins can change the plan or open the billing
                portal.
              </p>
            ) : state.managed ? (
              <>
                {/* The portal stays reachable under a grant — the subscription
                    behind it still has a card and invoices — but it is no
                    longer where the plan is decided, so it is not offered as
                    the way to change one. */}
                <p className="text-sm text-white/65">
                  {subscribed && !granted ? "Plan changes, payment" : "Payment"}{" "}
                  method, invoices and cancellation live in the billing portal.
                </p>
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => go("portal", () => portal())}
                >
                  {busy === "portal" ? "Opening…" : "Manage billing"}
                </Button>
              </>
            ) : nothingToBuy ? (
              <p className="text-sm text-white/65">
                This team&apos;s plan is set by the operator of this instance,
                so there is nothing to buy here.
              </p>
            ) : (
              <p className="text-sm text-white/65">
                Choose a plan below to raise this team&apos;s monthly allowance.
              </p>
            )}
          </div>
          {error && (
            <div className="flex flex-col gap-1">
              <Alert>{error}</Alert>
              {detail && (
                <p className="font-mono text-xs break-all text-white/40">
                  {detail}
                </p>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plans</CardTitle>
        </CardHeader>
        <CardBody>
          {granted ? (
            <p className="text-sm text-white/50">
              This team is on the {state.plan} plan by a grant from the operator
              of this instance.
              {state.managed &&
                " A subscription also exists; the grant takes precedence — it can still be managed in the billing portal above."}
            </p>
          ) : nothingToBuy ? (
            <p className="text-sm text-white/50">
              This instance includes unlimited sending; there is nothing to buy.
            </p>
          ) : catalog.length === 0 ? (
            <p className="text-sm text-white/50">
              The plan catalogue is unavailable right now. Your plan and usage
              above are unaffected; try again in a moment.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {subscribed && canManage && (
                <p className="text-sm text-white/50">
                  This team already has a subscription, so plan changes are made
                  in the billing portal — it switches the subscription you have
                  rather than opening a second one.
                </p>
              )}
              <ul className="grid gap-4 sm:grid-cols-3">
                {catalog.map((p) => {
                  const isCurrent = p.plan === state.plan;
                  return (
                    <li
                      key={p.plan}
                      className={cn(
                        "flex flex-col gap-2 rounded-md border p-4",
                        isCurrent
                          ? "border-indigo-500/60 bg-indigo-500/8"
                          : "border-white/10",
                      )}
                    >
                      <p className="num-stamp">{p.name}</p>
                      <p className="text-2xl font-semibold tabular-nums">
                        {money(p.priceCents)}
                        {p.priceCents > 0 && (
                          <span className="text-sm font-normal text-white/50">
                            {" "}
                            / mo
                          </span>
                        )}
                      </p>
                      <p className="text-sm text-white/65">
                        {n(p.includedEmails)} emails
                        {p.overagePer1kCents > 0
                          ? `, then ${money(p.overagePer1kCents)} per 1,000`
                          : ", capped"}
                      </p>
                      <div className="mt-auto pt-2">
                        {isCurrent ? (
                          <p className="text-sm text-indigo-300">
                            Current plan
                          </p>
                        ) : !canManage ? null : subscribed ? (
                          // Checkout would be refused for this team, so the tile
                          // offers the move that works instead of the one that
                          // does not. Secondary, because it is the same portal
                          // the card above already links to — not a second,
                          // competing primary action per tile.
                          <Button
                            variant="secondary"
                            className="w-full"
                            disabled={pending}
                            onClick={() =>
                              go(`portal:${p.plan}`, () => portal())
                            }
                          >
                            {busy === `portal:${p.plan}`
                              ? "Opening…"
                              : "Change in portal"}
                          </Button>
                        ) : (
                          <Button
                            className="w-full"
                            disabled={pending}
                            onClick={() => go(p.plan, () => checkout(p.plan))}
                          >
                            {busy === p.plan
                              ? "Opening…"
                              : p.plan === "free"
                                ? "Downgrade"
                                : "Choose"}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </CardBody>
      </Card>

      <p className="text-sm text-white/50">
        Sendsprite sends through your own Amazon SES account, so AWS bills you
        for delivery at cost. These plans are for the Sendsprite control plane.
      </p>
    </>
  );
}
