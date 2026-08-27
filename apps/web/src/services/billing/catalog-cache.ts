import type { Plan } from "@sendsprite/shared";
import type { PlanProduct } from "./provider";

/**
 * The plan catalog, cached in-process for the send path.
 *
 * An operator grant and `DEFAULT_PLAN` name a plan; its allowance lives in
 * Polar product metadata, and `resolveTeamCaps` runs on every send — a
 * provider call per send is not on. So: one catalog read every `CATALOG_TTL_MS`,
 * the last good value kept across an outage (an outage must never change a
 * cap), and `undefined` when nothing has ever loaded, which the caller turns
 * into the Free allowance with a logged error.
 *
 * This is a module-level singleton, not one cache per caller: every caller
 * must pass the same `load`. In production that is `defaultCatalogLoader`
 * from `services/billing/index.ts` (a later task) — the provider is not
 * imported here to avoid a cycle with `plans.ts`.
 *
 * The staleness window is unbounded by design: a refresh failure just pushes
 * the next attempt out by another `CATALOG_TTL_MS` rather than retrying every
 * call, so an outage never turns into a retry storm and never turns into a
 * changed cap either. Before the first successful load, "this plan is not in
 * the catalog" and "nothing has ever loaded" are indistinguishable — both
 * read as `undefined`, and the caller falls back to the Free allowance with a
 * logged error either way.
 */
export const CATALOG_TTL_MS = 10 * 60 * 1000;

type Loader = () => Promise<PlanProduct[]>;

let cache: { byPlan: Map<Plan, number> } | null = null;
// -Infinity: stale on the very first call, without a null-check at the call site.
let attemptedAt = -Infinity;
let inflight: Promise<void> | null = null;
let clock: () => number = () => Date.now();

async function refresh(load: Loader): Promise<void> {
  try {
    const products = await load();
    cache = {
      byPlan: new Map(products.map((p) => [p.plan, p.includedEmails])),
    };
  } catch (e) {
    console.error("[billing] catalog refresh failed; keeping the last one", e);
  } finally {
    // Set unconditionally, success or failure, and only once `load()` has
    // settled: a failure must still push the next attempt out by a full TTL,
    // or a down provider gets hit on every call. Setting it here rather than
    // before the `await` also keeps `stale` true for the whole in-flight
    // window, which is what lets a concurrent call join `inflight` instead of
    // reading a still-empty `cache` early.
    attemptedAt = clock();
  }
}

/**
 * Included emails for `plan`, or undefined when the catalog has no entry for
 * it or nothing has ever loaded successfully.
 *
 * `plan` is `Plan`, not `GrantedPlan`: `unlimited` has no catalog entry by
 * definition, and the caller resolves it before reaching this function.
 */
export async function cachedPlanIncluded(
  plan: Plan,
  load: Loader,
): Promise<number | undefined> {
  const stale = clock() - attemptedAt >= CATALOG_TTL_MS;
  if (stale) {
    inflight ??= refresh(load).finally(() => (inflight = null));
    await inflight;
  }
  return cache?.byPlan.get(plan);
}

/** Test-only seam: point the cache's clock at a fake one. */
export function setCatalogClockForTests(fn: () => number): void {
  clock = fn;
}

/**
 * Resets cache, backoff and clock. The caller is responsible for having
 * awaited any in-flight refresh first — this does not cancel one, it only
 * forgets about it, so a refresh started before a reset can still land and
 * repopulate `cache` after the reset returns.
 */
export function resetCatalogCacheForTests(): void {
  cache = null;
  attemptedAt = -Infinity;
  inflight = null;
  clock = () => Date.now();
}
