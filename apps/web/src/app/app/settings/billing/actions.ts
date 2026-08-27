"use server";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/audit";
import { requireTeam } from "@/lib/session";
import * as billing from "@/services/billing";

export type { Result } from "@/lib/result";

/**
 * Server actions are thin: resolve the actor, delegate. The permission check
 * (`billing.manage`), the `BILLING_ENABLED` guard and the plan → product
 * lookup all live in the service, so a caller that reaches these exports by
 * any route — this form, a future REST endpoint — is refused the same way.
 */
async function actor() {
  const ctx = await requireTeam();
  return {
    userId: ctx.userId,
    teamId: ctx.team.id,
    role: ctx.role,
    email: ctx.session.user.email,
    meta: requestMeta(await headers()),
  };
}

/**
 * A checkout URL for `plan`. The client navigates to it; redirecting from the
 * action would lose the typed refusal, and the provider's checkout page lives
 * on another origin. `plan` arrives from the client untyped and is resolved
 * against the provider's catalog inside the service — never trusted as a
 * product id.
 *
 * Nothing local changes here (the subscription arrives later, by webhook), so
 * there is nothing to revalidate.
 */
export async function checkout(plan: string) {
  return billing.startCheckout(await actor(), plan);
}

/** A customer-portal URL for the team's existing subscription. */
export async function portal() {
  return billing.openPortal(await actor());
}
