import type { GrantedPlan } from "@sendsprite/shared";
import { loadEnv, type Env } from "@/env.schema";

/**
 * Everything billing reads from the environment, resolved once. Taking `Env`
 * as an argument keeps this pure and testable; the default is the process
 * env, and `loadEnv` (not `@/env`) is used so the worker and CLI — which must
 * not pull `server-only` — can call it too.
 */
export interface BillingConfig {
  enabled: boolean;
  provider: "polar" | "fake";
  accessToken: string | null;
  webhookSecret: string | null;
  server: "sandbox" | "production";
  /** Usage event name; the hand-made provider meter filters on it. */
  eventName: string;
  /** Display only; null when unset. Billing never needs it. */
  meterId: string | null;
  /** Plan a team with no subscription and no grant resolves to. */
  defaultPlan: GrantedPlan;
  /** Where the provider sends the browser after a successful checkout. */
  successUrl: string;
  /** Where the customer portal's back link points. */
  returnUrl: string;
}

const BILLING_PATH = "/app/settings/billing";

export function billingConfig(env: Env = loadEnv()): BillingConfig {
  const base = env.APP_URL.replace(/\/+$/, "");
  return {
    enabled: env.BILLING_ENABLED,
    provider: env.BILLING_PROVIDER,
    accessToken: env.POLAR_ACCESS_TOKEN ?? null,
    webhookSecret: env.POLAR_WEBHOOK_SECRET ?? null,
    server: env.POLAR_SERVER,
    eventName: env.BILLING_EVENT_NAME,
    meterId: env.POLAR_METER_ID ?? null,
    defaultPlan: env.DEFAULT_PLAN,
    // `{CHECKOUT_ID}` is substituted by the provider at redirect time.
    successUrl: `${base}${BILLING_PATH}?checkout={CHECKOUT_ID}`,
    returnUrl: `${base}${BILLING_PATH}`,
  };
}

/** Cheap guard for pages and routes that must 404 with billing off. */
export const billingEnabled = (): boolean => billingConfig().enabled;
