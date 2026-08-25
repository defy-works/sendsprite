import { notFound } from "next/navigation";
import { can } from "@sendsprite/shared";
import { requireTeam } from "@/lib/session";
import { planCatalog, teamBillingState } from "@/services/billing";
import { billingConfig } from "@/services/billing/config";
import {
  billingRow,
  meteringPeriodStart,
  PAST_DUE_GRACE_MS,
} from "@/services/billing/plans";
import { BillingPanel } from "./BillingPanel";

export const metadata = { title: "Billing" };

const DAY_MS = 24 * 3600 * 1000;

/**
 * Plan, allowance and this period's usage, for **every** member of the team.
 *
 * That is a decision, not an oversight: `teamBillingState` has no permission
 * gate, and this page does not add one. The page shows what the team is
 * entitled to and how much of it is left — the same facts a member already
 * learns the hard way from a `monthly_quota_exceeded` on a send — plus list
 * prices, which are public. It shows no payment instrument, no invoice, no
 * amount charged and no customer record; all of that lives behind the
 * provider's portal, which needs `billing.manage`. The *actions* are gated in
 * the service (`startCheckout`/`openPortal`), so a member seeing the page can
 * do nothing with it but read.
 */
export default async function BillingPage() {
  // With billing off the page does not exist — a self-hoster must not find a
  // half-working purchase flow by typing the URL.
  if (!billingConfig().enabled) notFound();
  const ctx = await requireTeam();
  const now = new Date();
  const [state, catalog, row] = await Promise.all([
    teamBillingState(ctx.team.id),
    planCatalog(),
    billingRow(ctx.team.id),
  ]);

  // Everything that depends on "now" is resolved here rather than in the
  // client component: the same reason the members page formats dates on the
  // server. A client computing a deadline would disagree with the SSR markup
  // on the first paint, and a hydration mismatch on a payment warning is the
  // last place to spend that risk.
  const graceEndsAt = state.pastDueAt
    ? Date.parse(state.pastDueAt) + PAST_DUE_GRACE_MS
    : null;

  /**
   * `state.used` is counted over the *entitlement* window; `reportedUnits` is
   * read from the watermark row, which is keyed on the *stored* period
   * (amendment E — the asymmetry is deliberate and must not be collapsed).
   * The two usually name the same month, but during a renewal lag, or for the
   * whole life of a row whose status stopped entitling, they do not — and
   * "12,000 of 50,000 used" beside "45,000 reported" is then just confusing.
   * Where the windows disagree the reported figure is withheld rather than
   * qualified: a number nobody can line up is worse than no number.
   */
  const reportedCoversPeriod =
    meteringPeriodStart(row, now).getTime() === Date.parse(state.periodStart);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <BillingPanel
        state={state}
        catalog={catalog.products.map((p) => ({
          plan: p.plan,
          name: p.name,
          priceCents: p.priceCents,
          includedEmails: p.includedEmails,
          overagePer1kCents: p.overagePer1kCents,
        }))}
        canManage={can(ctx.role, "billing.manage")}
        // Rendered from what the state says, not from what a status implies: a
        // `past_due` row with no stamp (written before the clock existed) still
        // gets its banner, without a deadline it cannot know.
        pastDue={
          state.status === "past_due"
            ? {
                deadline:
                  graceEndsAt === null
                    ? null
                    : new Date(graceEndsAt).toISOString(),
                expired: graceEndsAt !== null && now.getTime() >= graceEndsAt,
              }
            : null
        }
        daysLeft={Math.max(
          0,
          Math.ceil((Date.parse(state.periodEnd) - now.getTime()) / DAY_MS),
        )}
        showReported={reportedCoversPeriod}
        // Only an instance owner is handed the provider's own words: they name
        // environment variables, and they are noise to anyone who cannot set
        // them. The filter is here, on the server, so the string never reaches
        // a non-owner's HTML at all — there is nothing for the client to hide.
        providerDetail={can(ctx.role, "instance.manage") ? catalog.error : null}
      />
    </div>
  );
}
