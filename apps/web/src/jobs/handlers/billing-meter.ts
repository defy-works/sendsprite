import { registerQueue } from "../boss";
import { Q } from "../queues";
import { getBillingProvider } from "@/services/billing";
import { billingConfig } from "@/services/billing/config";
import { rollupUsage, type RollupSummary } from "@/services/billing/usage";

const NOTHING: RollupSummary = { teams: 0, events: 0, units: 0, failed: 0 };

/**
 * Cron: meter every subscribed team's settled hours to the payment provider.
 *
 * Runs at :37 so the hour that closed at the top of the hour has cleared the
 * 30-minute settle window and is reported on the very next tick — at :07 the
 * horizon still falls on the hour before that, and every bucket would wait an
 * extra hour for nothing. Exported so tests can drive it directly.
 *
 * Nothing here can fail a send: metering is strictly downstream of delivery
 * and runs only on this cron. A provider outage is swallowed — by
 * `rollupUsage` for the ingest itself, and here for a provider that cannot
 * even be built — so watermarks simply do not advance and the next tick
 * re-sends the same buckets, which the provider deduplicates on their
 * `externalId`.
 */
export async function runBillingMeterSweep(
  now = new Date(),
): Promise<RollupSummary> {
  const cfg = billingConfig();
  if (!cfg.enabled) return NOTHING;
  let provider;
  try {
    provider = await getBillingProvider();
  } catch (e) {
    console.error(
      "[billing] meter sweep skipped: provider unavailable:",
      (e as Error).message,
    );
    return NOTHING;
  }
  const s = await rollupUsage(provider, cfg.eventName, now);
  console.info(
    `[billing] metered ${s.units} emails in ${s.events} events for ${s.teams} team(s); ${s.failed} deferred`,
  );
  return s;
}

// Registered unconditionally; the handler itself is the gate (`cfg.enabled`
// above, first line). It used to be `if (billingConfig().enabled)` around
// this call, which read the env at import time — and every test that started
// the worker then depended on APP_URL having been set by someone else before
// this module loaded. A self-hosted instance now gets one no-op tick an hour,
// which costs nothing and keeps the env read where it can be reasoned about.
//
// The sweep is a plain cron and never enqueues itself — a handler that
// re-enqueues onto its own exclusive queue has silently stalled twice in
// earlier phases. A missed tick needs no recovery: the next one rebuilds
// exactly the same buckets.
registerQueue(Q.billingMeterSweep, () => runBillingMeterSweep(), {
  cron: "37 * * * *",
  // retryLimit 0: a failed run is simply retried by the next tick, and the
  // rollup is idempotent, so there is nothing a pg-boss retry would add.
  queue: { retryLimit: 0 },
});
