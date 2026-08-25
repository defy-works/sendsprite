# Phase 5 — Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Charge for the hosted Sendsprite control plane — tiered subscriptions with usage overage on emails sent — behind `BILLING_ENABLED` (default off) so a self-hosted instance never sees any of it.

**Architecture:** Everything payment-shaped sits behind one interface, `BillingProvider` (`apps/web/src/services/billing/provider.ts`). A Polar implementation and an in-memory fake implement it; nothing outside `services/billing/polar.ts` imports `@polar-sh/sdk`, and that import is lazy so a self-hoster never loads it. Plans are **read from Polar product metadata**, never from hardcoded product IDs: `metadata.plan` / `included_emails` / `overage_per_1k_cents` on each product decide what a subscription entitles, and the resolved snapshot is written to `team_billing` so rendering the dashboard needs no Polar call. Entitlements are not a new mechanism — they feed the caps `apps/web/src/services/send-limits.ts` already enforces, so the existing `daily_quota_exceeded` / `monthly_quota_exceeded` codes and `x-ratelimit-*` headers keep working. Usage is metered by **closed hourly rollups** ingested with a deterministic `externalId` (`<teamId>:<bucketStart>`), which turns Polar's at-least-once retry into exactly-once by construction and costs ~720 API calls per team per month instead of 300 000; a failed ingest advances nothing and never touches the send path.

**Tech Stack:** Bun 1.3 workspaces, TypeScript 5.9, zod 4, Next 16 (App Router, server actions), Drizzle 0.45 + drizzle-kit 0.31 on Postgres, pg-boss 12, `@polar-sh/sdk` ^0.49.0 (checked on npm 2026-08-25: `latest` 0.49.0; `next` is 1.0.0-alpha.17 — stay on `latest`), Vitest 4 (+ embedded-postgres for integration), Playwright.

---

## Decisions already made (recorded, not up for relitigation)

1. **Payment provider is Polar**, acting as merchant of record. The founder is resident in South Korea and Stripe cannot pay out to Korean bank accounts; Polar pays out to Korea via Stripe Connect Express and has first-class usage-based billing. Polar also handles VAT/sales tax as MoR, which a two-person company should not be building.
2. **Pricing is tiers + overage on emails sent.** The sandbox catalog already exists in the Polar org `Sendsprite` (`01ab540b-e2bd-4386-9849-2190aca34b2e`):

   | Product          | `metadata.plan` | Fixed price | `included_emails` | `overage_per_1k_cents` |
   | ---------------- | --------------- | ----------- | ----------------- | ---------------------- |
   | Sendsprite Free  | `free`          | $0/mo       | 3 000             | 0                      |
   | Sendsprite Pro   | `pro`           | $12/mo      | 50 000            | 40                     |
   | Sendsprite Scale | `scale`         | $49/mo      | 300 000           | 25                     |

3. **Product IDs must never be hardcoded.** The app maps subscription → plan by reading the product's `metadata`, and finds the products to check out by listing them and filtering on `metadata.plan`. Prices and product ids can therefore change in the Polar dashboard without a deploy.
4. **Billing ships in this repo behind `BILLING_ENABLED`, default off.** With it off, the dashboard has no Billing page, the webhook/checkout/portal endpoints 404, no billing cron is registered, and `send-limits.ts` behaves exactly as it does today. The provider seam exists so the Polar implementation could later move to a private package (or be swapped) without redesign.
5. **The hosted service is BYOK SES.** Customers connect their own AWS account through the Phase 2 one-click flow. We bill for the control plane, not for email: there is no per-email COGS, delivery is billed to the customer by AWS at cost. Metering counts emails accepted by _our_ API, which is why `emails.created_at` is the meter and SES is irrelevant to it.

### Verified against the live sandbox while writing this plan (2026-08-25)

Two things the brief listed as unknown turned out to be already in place. **Neither becomes a dependency** — see "Two open externals" — but the implementer should not be surprised by them:

- A meter named `emails` exists: `fb2f372a-f6a8-4697-93d6-adab7f76e4ad`, `unit: "scalar"`.
- Pro and Scale each already carry a second, `metered_unit` price bound to that meter — Pro `unit_amount: "0.040000000000"`, Scale `"0.025000000000"`. Polar's `unit_amount` for metered prices is **in cents**, so those are 0.04 ¢ and 0.025 ¢ per email = 40 ¢ and 25 ¢ per 1 000, matching `overage_per_1k_cents` exactly. Free has no metered price, which is correct: Free is a hard cap, not an overage tier.

So `unit_based_pricing_enabled: false` in the org payload does **not** mean metered pricing is unavailable — the prices exist. Treat that field as unread.

### Two open externals — written around, not resolved

- **The meter is hand-made in the Polar dashboard and its id is configuration, not code.** This plan never needs the meter id to bill: usage events are ingested by _name_ (`BILLING_EVENT_NAME`, default `email.sent`), and Polar accepts events whether or not a meter matches them. `POLAR_METER_ID` exists as an _optional_ env used for exactly one thing — a "Polar's own count" line on the billing page for reconciliation. Unset, the page shows our counters only and nothing else changes.
- **Whether metered overage is live for the org is not this phase's problem.** Fixed-tier billing works on its own: a plan whose subscription carries no metered price gets a **hard monthly cap at `included_emails`** (429 `monthly_quota_exceeded`), and a plan whose subscription _does_ carry one gets **no monthly cap** and is billed for the excess. That boolean is read off the subscription payload (`prices.some(p => p.amountType === "metered_unit")`) and stored on `team_billing.overage_enabled` — so the day metered pricing is switched on in Polar, the next `subscription.updated` webhook flips behaviour with no deploy. There is no env flag gating it and no code path that assumes it.

---

## Read first (existing code the tasks build on)

- `apps/web/src/services/send-limits.ts` — `checkTeamCaps`, `checkInstanceQuota`, `takeSesToken`, `usageSnapshot`, `UsageSnapshot`, the `ACTIVE` status tuple and the UTC `startOfDay`/`startOfMonth` helpers. **This is the file entitlements extend; do not build a parallel quota system.**
- `apps/web/src/services/emails.ts` lines ~212-215 — the one place per-team caps are checked (`createBatch` loops `createEmail`, so it is the only choke point).
- `apps/web/src/lib/api-response.ts` — `fail`, `ok`, `serviceFailure`, `rateHeaders`, `tooLarge`, `MAX_BODY_BYTES`, `readJson`, `withApiKey`, `RouteContext`.
- `apps/web/src/lib/result.ts` — `Result<T>`, `isErrorCode`.
- `apps/web/src/services/email-events.ts` `recordEvent` — the house pattern for an **idempotent insert keyed on a dedupe column** plus a **conditional UPDATE that cannot regress state**. The billing webhook copies both ideas.
- `apps/web/src/services/instance-settings.ts` — the settings-service shape (singleton read, upsert with explicit `updatedAt`, `recordAudit` with `computeDiff`).
- `apps/web/src/services/team.ts` — `TeamActor`, `authorized(actor, action, fn)`, `DENIED`. Billing mutations use the same wrapper.
- `apps/web/src/db/schema/{team-settings,webhooks,email-events}.ts` — the table conventions (see "Conventions" below).
- `apps/web/src/db/keyset.ts`, `apps/web/src/lib/cursor.ts` — keyset paging (`billing_events` is shaped so it can be paged later; nothing in this phase pages it).
- `apps/web/src/jobs/{boss,queues,enqueue}.ts` and `apps/web/src/jobs/handlers/retention-purge.ts` — the four-edit recipe for a new cron queue.
- `apps/web/src/env.schema.ts` — the `bool` coercer and the `LANDING_ENABLED` flag pattern; `apps/web/tests/unit/env.test.ts` asserts defaults.
- `apps/web/src/app/app/settings/{page.tsx,actions.ts,RenameForm.tsx}` — page → thin server action → service → `revalidatePath`, `useActionState`, inline `role="alert"` errors.
- `apps/web/src/app/app/StatsTiles.tsx` — the `num-stamp` label + `metric-xl` number tile, and `AlertBanners` (the amber/red `role="alert"` banner idiom).
- `apps/web/src/components/ui/*` — `Card`/`CardHeader`/`CardTitle`/`CardBody`, `Button`, `Badge`, `EmptyState`, `Alert`, `Link`, `StatusDot`. **There is no modal, tabs or toast primitive; do not add one.**
- `apps/web/src/app/docs/nav.ts` + any `page.mdx` — how a docs page is registered.
- `apps/web/tests/integration/{_pg.ts,helpers.ts}` and `apps/web/tests/integration/rest-suppressions.test.ts` — `startPg()` per file, `seedTeamWithKey()`, dynamic `await import("@/…")` **after** `startPg()` has set `DATABASE_URL`.

---

## Conventions carried over from Phases 1–4

- Commit messages: conventional (`feat(billing): …`), **no `Co-Authored-By`, no AI attribution**.
- Every task ends green: `bun run typecheck && bun run lint && bun run format && bun run test` at the root, plus `bun run test:integration` when `apps/web` service, schema or route code changed.
- Schema: `pgTable("snake_case", { camelCase: type("snake_case") }, (t) => [ …indexes… ])` — array form for the third argument. **Never `pgEnum`**; always `text("col", { enum: TUPLE })` with an `as const` tuple. Ids are `text("id").primaryKey()` minted in app code by `newId(prefix)` — never a DB default — with a trailing comment naming the prefix. `teamId` is `text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" })`.
- Timestamps are always `withTimezone: true`. `precision: 3` is added **only** to the `created_at` of a table that is (or plausibly will be) keyset-paged, because the cursor round-trips the value through a JS `Date` — a microsecond column makes the keyset comparison skip rows written in the same millisecond. In this phase that means `billing_events.created_at` gets `precision: 3` and the other two tables do not.
- `updatedAt` uses `.$onUpdate(() => new Date())`, which **does not fire on `onConflictDoUpdate`** — every upsert sets `updatedAt: new Date()` explicitly.
- Migrations: `bun run db:generate`, then rename the generated file to describe the change and edit the matching `tag` in `apps/web/drizzle/meta/_journal.json` (the 0009–0011 precedent).
- Services return `Result<T>`; only infrastructure errors throw. Server actions are thin: resolve the actor, delegate, `revalidatePath`.
- Integration tests use embedded Postgres via `tests/integration/_pg.ts` (**no Docker on the dev machine**); each file calls `startPg()` in `beforeAll` and imports `@/…` modules dynamically afterwards.
- **Never self-enqueue from a pg-boss `exclusive` queue handler.** The billing rollup is a plain cron with `retryLimit: 0`, so the rule is respected by construction; do not "improve" it into a self-rescheduling job.

---

## Phase 5 openers — what this phase absorbs, and what it does not

The Phase 4 plan closes with 30 open items. Read `docs/superpowers/plans/2026-08-25-phase-4-developer-surface.md` § "Phase 5 openers" before starting. Disposition:

**Displaced, not dropped.** Openers 1–4 (templates + variables, contacts/audiences, CLI `templates pull|push`, MCP `list_templates`/`render_template`/`add_contact`, the `/docs` Templates page) were written as "the body of Phase 5". Billing takes that slot; **they move to Phase 6 verbatim**. Task 12 updates the README roadmap line accordingly — it currently promises "Phase 5 (next): templates, preview, contacts, campaigns, audit UI" and would otherwise be a lie. `AppShell`'s `NAV` already links `/app/templates`, `/app/contacts`, `/app/campaigns` at pages that do not exist; that stays as-is (out of scope), it is not made worse.

**Absorbed by this phase:**

- **Opener 21 — body caps on non-email routes.** `POST /api/billing/webhook` is publicly reachable before any signature check, so Task 7 gives it its own small cap (64 KB) rather than inheriting the 25 MB email cap. That closes the opener for the one route this phase adds; the rest of the REST surface is still uncapped.
- **Opener 8 — consistent audit action naming.** This phase introduces the first new action family since the convention was questioned. It commits to `<resource>.<verb>`: `billing.checkout`, `billing.portal`, `billing.subscription.updated`, `billing.subscription.canceled`. Existing names (`team.rename`, `members.invite`, `instance.update`) already fit; nothing is renamed here, but the convention is now written down (Task 6).
- **Opener 11 — team ids carry no prefix.** This phase makes it customer-visible: the team id becomes the Polar `external_customer_id`, so it shows up in the Polar dashboard and on invoices' metadata. Task 12 documents the exception in `/docs/billing` and the README. **It does not change team ids** — that is an auth-provider migration and would invalidate every existing Polar customer mapping the moment one exists. Decide it before the first production customer, not after.

**Deliberately left alone:** openers 5–7 (audit log UI, audit rows for cancel/resend/reschedule, REST audit ip/UA) — billing writes audit rows through the existing `recordAudit`, so a later audit UI picks them up for free; 9 (`sending_only` scope on `GET /emails`) — an API-surface decision that belongs with the templates phase; 10, 12–16 (stream connection cap, MCP host allowlist, MCP stdout hazard, `workspace:*` publish, CLI column padding, CLI password prompt); 17–25 (the Phase 3 carry-overs); 26–30 (operational). Note that **opener 26 (push to GitHub) and 28 (real AWS validation) become blocking for _shipping_ billing, not for building it**: Polar cannot deliver a webhook to a machine that is not on the internet, so the first end-to-end Polar test needs a deployed instance or a tunnel. Everything in this plan is testable without one.

**New openers this phase creates** are collected in Task 12's status block.

---

## File structure

```
packages/shared/src/
  api/billing.ts                     NEW: PLANS, PlanMetadata, BillingStateObject,
                                          planFromProductMetadata(), SUBSCRIPTION_STATUSES
                                          (PlanEntitlement is NOT here -- it is a server-side
                                          concern, defined in services/billing/plans.ts, Task 5)
  index.ts                           + export * from "./api/billing" (modified)

apps/web/
  package.json                       + "@polar-sh/sdk": "^0.49.0" (modified)
  drizzle/0012_billing.sql           NEW (generated, then renamed + journal tag edited)
  src/env.schema.ts                  + BILLING_ENABLED, BILLING_PROVIDER, BILLING_EVENT_NAME,
                                       POLAR_ACCESS_TOKEN, POLAR_WEBHOOK_SECRET, POLAR_SERVER,
                                       POLAR_METER_ID + two refines (modified)
  src/db/schema/billing.ts           NEW: teamBilling, billingUsage, billingEvents
  src/db/schema/index.ts             + export * from "./billing" (modified)

  src/services/billing/provider.ts   NEW: BillingProvider, PlanProduct, ProviderSubscription,
                                          ProviderEvent, UsageEvent, BillingUnavailableError
  src/services/billing/config.ts     NEW: billingConfig() — the one place env is read
  src/services/billing/fake.ts       NEW: in-memory provider (tests, e2e, BILLING_PROVIDER=fake)
  src/services/billing/polar.ts      NEW: Polar implementation; lazy `await import("@polar-sh/sdk")`
  src/services/billing/index.ts      NEW: getBillingProvider(), teamBillingState(),
                                          applySubscription(), applyOrderPaid(), recordBillingEvent(),
                                          startCheckout(), openPortal()
  src/services/billing/plans.ts      NEW: resolvePlan(), planEntitlement(), FREE_ENTITLEMENT
  src/services/billing/usage.ts      NEW: currentWindow(), countSentIn(), hourlyBuckets(),
                                          rollupTeamUsage(), rollupUsage()
  src/services/send-limits.ts        + resolveTeamCaps(); checkTeamCaps and usageSnapshot use it (modified)
  src/lib/api-response.ts            rateHeaders gains the monthly branch (modified)

  src/jobs/queues.ts                 + billingMeterSweep (modified)
  src/jobs/handlers/billing-meter.ts NEW: cron `7 * * * *` → rollupUsage()
  src/jobs/handlers/index.ts         + import "./billing-meter" (modified)

  src/app/api/billing/webhook/route.ts        NEW
  src/app/app/settings/billing/page.tsx       NEW
  src/app/app/settings/billing/actions.ts     NEW
  src/app/app/settings/billing/BillingPanel.tsx NEW
  src/app/app/settings/page.tsx               + Billing card when enabled (modified)
  src/app/docs/billing/page.mdx               NEW
  src/app/docs/nav.ts                         + Billing (modified)

  tests/unit/billing-plans.test.ts            NEW
  tests/unit/billing-usage-buckets.test.ts    NEW
  tests/unit/env.test.ts                      + billing env cases (modified)
  tests/integration/billing-webhook.test.ts   NEW
  tests/integration/billing-entitlements.test.ts NEW
  tests/integration/billing-rollup.test.ts    NEW
  tests/e2e/billing.spec.ts                   NEW
  playwright.config.ts                        + BILLING_ENABLED/BILLING_PROVIDER in webServer env (modified)

.env.example                         + billing block (modified)
README.md                            + billing paragraph, env rows, roadmap (modified)
```

---

## Task 1: Shared billing contracts

Plans, the product-metadata contract and the dashboard's view object live in `@sendsprite/shared` so the web app, a future SDK surface and the OpenAPI generator all read one definition.

**Files:**

- Create: `packages/shared/src/api/billing.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/tests/billing.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/shared/tests/billing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BillingStateObject,
  FREE_PLAN_METADATA,
  PLANS,
  PlanMetadata,
  SUBSCRIPTION_STATUSES,
  isEntitledStatus,
  planFromProductMetadata,
} from "../src/index";

describe("plan metadata", () => {
  it("parses the metadata Polar products carry", () => {
    expect(
      planFromProductMetadata({
        plan: "pro",
        included_emails: 50000,
        overage_per_1k_cents: 40,
      }),
    ).toEqual({ plan: "pro", includedEmails: 50000, overagePer1kCents: 40 });
  });

  it("accepts the numbers as strings (Polar metadata values may be text)", () => {
    expect(
      planFromProductMetadata({
        plan: "scale",
        included_emails: "300000",
        overage_per_1k_cents: "25",
      }),
    ).toEqual({ plan: "scale", includedEmails: 300000, overagePer1kCents: 25 });
  });

  it("returns null for an unknown or missing plan instead of throwing", () => {
    expect(planFromProductMetadata({ plan: "enterprise" })).toBeNull();
    expect(planFromProductMetadata({})).toBeNull();
    expect(planFromProductMetadata(undefined)).toBeNull();
    expect(planFromProductMetadata({ plan: "pro" })).toBeNull(); // no included_emails
  });

  it("PLANS is ordered cheapest first and FREE_PLAN_METADATA is the fallback", () => {
    expect(PLANS).toEqual(["free", "pro", "scale"]);
    expect(FREE_PLAN_METADATA).toEqual({
      plan: "free",
      includedEmails: 3000,
      overagePer1kCents: 0,
    });
    expect(PlanMetadata.safeParse(FREE_PLAN_METADATA).success).toBe(true);
  });
});

describe("subscription status", () => {
  it("entitles active, trialing and past_due; not canceled/unpaid/incomplete", () => {
    expect(SUBSCRIPTION_STATUSES).toContain("past_due");
    for (const s of ["active", "trialing", "past_due"] as const)
      expect(isEntitledStatus(s)).toBe(true);
    for (const s of ["canceled", "unpaid", "incomplete", "paused"] as const)
      expect(isEntitledStatus(s)).toBe(false);
    // An unknown status from a provider we do not model is not entitling.
    expect(isEntitledStatus("something_new")).toBe(false);
  });
});

describe("BillingStateObject", () => {
  it("parses what the dashboard renders", () => {
    expect(
      BillingStateObject.safeParse({
        enabled: true,
        plan: "pro",
        status: "active",
        includedEmails: 50000,
        overagePer1kCents: 40,
        overageEnabled: true,
        cancelAtPeriodEnd: false,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
        used: 1234,
        reportedUnits: 1200,
        managed: true,
      }).success,
    ).toBe(true);
    // A team that never touched Polar: free plan, nothing managed.
    expect(
      BillingStateObject.safeParse({
        enabled: true,
        plan: "free",
        status: null,
        includedEmails: 3000,
        overagePer1kCents: 0,
        overageEnabled: false,
        cancelAtPeriodEnd: false,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
        used: 12,
        reportedUnits: 0,
        managed: false,
      }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && bunx vitest run tests/billing.test.ts`
Expected: FAIL — `planFromProductMetadata` and friends are not exported from `../src/index`.

- [ ] **Step 3: Write `packages/shared/src/api/billing.ts`**

```ts
import { z } from "zod";

/** Plan ladder, cheapest first. Matches `metadata.plan` on the Polar products. */
export const PLANS = ["free", "pro", "scale"] as const;
export type Plan = (typeof PLANS)[number];

/**
 * The contract each billing product carries in its provider-side metadata.
 * Product **ids are never hardcoded**: the app finds a product by listing the
 * catalog and matching `plan`, and maps a subscription to entitlements by
 * reading these three fields off the product the subscription points at. So
 * prices, ids and even the number of tiers can change without a deploy.
 */
export const PlanMetadata = z.object({
  plan: z.enum(PLANS),
  /** Emails included in the fixed monthly price. */
  includedEmails: z.number().int().min(0),
  /** Cents per 1 000 emails beyond `includedEmails`. 0 on a hard-capped plan. */
  overagePer1kCents: z.number().int().min(0),
});
export type PlanMetadata = z.infer<typeof PlanMetadata>;

/** What a team with no subscription at all gets. */
export const FREE_PLAN_METADATA: PlanMetadata = {
  plan: "free",
  includedEmails: 3000,
  overagePer1kCents: 0,
};

// Provider metadata values are `string | number | boolean`; Polar preserves the
// JSON type it was given, but a value typed by hand in the dashboard arrives as
// a string. Coerce rather than reject: a mistyped number must not un-plan a
// paying customer.
const int = z.coerce.number().int().min(0);
const RawPlanMetadata = z.object({
  plan: z.enum(PLANS),
  included_emails: int,
  overage_per_1k_cents: int.default(0),
});

/**
 * Provider product metadata → `PlanMetadata`, or `null` when the product is
 * not one of ours (or is missing the fields). Never throws: it runs inside
 * webhook handling, where a bad product must degrade to "free", not 500.
 */
export function planFromProductMetadata(
  metadata: unknown,
): PlanMetadata | null {
  const parsed = RawPlanMetadata.safeParse(metadata);
  if (!parsed.success) return null;
  return {
    plan: parsed.data.plan,
    includedEmails: parsed.data.included_emails,
    overagePer1kCents: parsed.data.overage_per_1k_cents,
  };
}

/**
 * Subscription lifecycle states we model. The list is Polar's, but the names
 * are generic enough to survive a provider swap; anything not in it is stored
 * verbatim and treated as not entitling.
 *
 * Verified in Task 5 against `SubscriptionStatus` in `@polar-sh/sdk@0.49.0`:
 * the eight below are exactly the SDK's set, in the same order, `paused`
 * included. No correction was needed. A unit test in `apps/web` pins the two
 * together so an SDK upgrade that changes the set fails loudly.
 */
export const SUBSCRIPTION_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * Statuses that keep the paid entitlement. `past_due` deliberately does:
 * dunning is the provider's job and cutting a customer's sending off the hour
 * a card expires is a worse failure than carrying them for a cycle. The
 * dashboard shows a banner instead (see the Billing page).
 */
const ENTITLED: ReadonlySet<string> = new Set([
  "trialing",
  "active",
  "past_due",
]);
export const isEntitledStatus = (status: string | null | undefined): boolean =>
  status != null && ENTITLED.has(status);

/** What the dashboard renders. `managed: false` = never went through checkout. */
export const BillingStateObject = z.object({
  enabled: z.boolean(),
  plan: z.enum(PLANS),
  status: z.string().nullable(),
  includedEmails: z.number().int(),
  overagePer1kCents: z.number().int(),
  /** The subscription carries a metered price, so sends past the include are billed. */
  overageEnabled: z.boolean(),
  cancelAtPeriodEnd: z.boolean(),
  periodStart: z.string(),
  periodEnd: z.string(),
  /** Emails created in this period that count (same rule as the send caps). */
  used: z.number().int(),
  /** Units already ingested to the provider this period. */
  reportedUnits: z.number().int(),
  /** There is a provider subscription behind this state. */
  managed: z.boolean(),
});
export type BillingStateObject = z.infer<typeof BillingStateObject>;
```

- [ ] **Step 4: Export it from the barrel**

In `packages/shared/src/index.ts`, add after the other `api/*` exports:

```ts
export * from "./api/billing";
```

No `node:` import is introduced, so `packages/shared/tests/root-barrel.test.ts` stays green. That test needs no edit: it walks the import graph from `index.ts` by matching `from "./…"`, which picks up `export * from "./api/billing"` automatically, so the new module is covered by the no-Node-builtins assertion the moment the barrel exports it.

- [ ] **Step 5: Run it to verify it passes**

Run: `cd packages/shared && bunx vitest run`
Expected: PASS, including `root-barrel.test.ts` (its walker now reaches `api/billing.ts`).

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): plan metadata contract and billing state object"
```

---

## Task 2: Schema — `team_billing`, `billing_usage`, `billing_events`

Three tables: one row per team holding the resolved subscription snapshot, one row per (team, period) holding the metering watermark, and an append-only log of provider webhook deliveries whose primary key **is** the delivery id, so idempotency is a primary-key conflict rather than a lookup.

**Files:**

- Create: `apps/web/src/db/schema/billing.ts`, `apps/web/drizzle/0012_billing.sql`
- Modify: `apps/web/src/db/schema/index.ts`, `apps/web/drizzle/meta/_journal.json`
- Test: `apps/web/tests/integration/billing-schema.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/tests/integration/billing-schema.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

describe("billing schema", () => {
  it("team_billing is 1:1 with the team and cascades on delete", async () => {
    const { db } = await import("@/db");
    const { teamBilling } = await import("@/db/schema");
    const { organization } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    await db()
      .insert(teamBilling)
      .values({
        teamId: team.id,
        plan: "pro",
        status: "active",
        includedEmails: 50000,
        overagePer1kCents: 40,
        overageEnabled: true,
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
        providerModifiedAt: new Date("2026-08-01T00:00:00Z"),
      });
    expect(
      await db()
        .select()
        .from(teamBilling)
        .where(eq(teamBilling.teamId, team.id)),
    ).toHaveLength(1);
    await db().delete(organization).where(eq(organization.id, team.id));
    expect(
      await db()
        .select()
        .from(teamBilling)
        .where(eq(teamBilling.teamId, team.id)),
    ).toHaveLength(0);
  });

  it("billing_usage is keyed on (team, periodStart)", async () => {
    const { db } = await import("@/db");
    const { billingUsage } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    const periodStart = new Date("2026-08-01T00:00:00Z");
    const row = {
      teamId: team.id,
      periodStart,
      periodEnd: new Date("2026-09-01T00:00:00Z"),
      reportedThrough: null,
      reportedUnits: 0,
    };
    await db().insert(billingUsage).values(row);
    await expect(db().insert(billingUsage).values(row)).rejects.toThrow();
    // The same team in a different period is a different row.
    await db()
      .insert(billingUsage)
      .values({ ...row, periodStart: new Date("2026-09-01T00:00:00Z") });
  });

  it("billing_events rejects a duplicate delivery id (the idempotency key)", async () => {
    const { db } = await import("@/db");
    const { billingEvents } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    const row = {
      id: "evt_delivery_1",
      teamId: team.id,
      type: "subscription.updated",
      objectId: "sub_1",
    };
    await db().insert(billingEvents).values(row);
    const inserted = await db()
      .insert(billingEvents)
      .values({ ...row, type: "subscription.created" })
      .onConflictDoNothing({ target: billingEvents.id })
      .returning();
    expect(inserted).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/billing-schema.test.ts`
Expected: FAIL — `teamBilling` / `billingUsage` / `billingEvents` are not exported from `@/db/schema`.

- [ ] **Step 3: Write `apps/web/src/db/schema/billing.ts`**

```ts
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { PLANS } from "@sendsprite/shared";
import { organization } from "./auth";

/**
 * One row per team once it has been through checkout: the entitlement
 * snapshot resolved from the provider's product metadata, so rendering the
 * billing page and enforcing caps never needs a provider call. A team with no
 * row is on the free plan.
 *
 * `providerModifiedAt` is the ordering guard: webhooks can arrive out of
 * order, so an update whose payload is older than what is stored is dropped
 * (the same idea as the status ranking in `services/email-events.ts`).
 */
export const teamBilling = pgTable("team_billing", {
  teamId: text("team_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  // Provider-side identifiers. `providerCustomerId` is the provider's own id;
  // the team id itself is the provider's `external_customer_id`.
  provider: text("provider").notNull().default("polar"),
  providerCustomerId: text("provider_customer_id"),
  subscriptionId: text("subscription_id"),
  productId: text("product_id"),
  plan: text("plan", { enum: PLANS }).notNull().default("free"),
  /** Provider status verbatim (`active`, `past_due`, …); null before any subscription. */
  status: text("status"),
  includedEmails: integer("included_emails").notNull(),
  overagePer1kCents: integer("overage_per_1k_cents").notNull().default(0),
  /** The subscription carries a metered price → no hard monthly cap. */
  overageEnabled: boolean("overage_enabled").notNull().default(false),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  /** `modified_at` of the newest provider payload applied; ordering guard. */
  providerModifiedAt: timestamp("provider_modified_at", {
    withTimezone: true,
  }).notNull(),
  pastDueAt: timestamp("past_due_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // `$onUpdate` fires only via drizzle `.update()`; upserts must set it.
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
export type TeamBilling = typeof teamBilling.$inferSelect;

/**
 * Metering watermark per team per billing period. `reportedThrough` is the
 * exclusive end of the last hourly bucket successfully ingested; it only ever
 * moves forward, and only after the provider returned 2xx. Nothing here is a
 * cache of the usage count — the count is read live from `emails`, the same
 * source the caps use, so the two can never disagree.
 */
export const billingUsage = pgTable(
  "billing_usage",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    reportedThrough: timestamp("reported_through", { withTimezone: true }),
    reportedUnits: integer("reported_units").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // `$onUpdate` fires only via drizzle `.update()`; upserts must set it.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.periodStart] })],
);
export type BillingUsage = typeof billingUsage.$inferSelect;

/**
 * Every provider webhook delivery we have seen. The primary key **is** the
 * delivery id from the `webhook-id` header (Standard Webhooks: unique per
 * delivery, reused on retries), so deduplication is an
 * `onConflictDoNothing` — no lookup, no race between two replicas handling
 * the same retry. Never key on the resource id: `order.created` and
 * `order.paid` share one.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: text("id").primaryKey(), // the provider's delivery id (`webhook-id`)
    teamId: text("team_id"), // null when the payload named no team
    type: text("type").notNull(),
    /** Provider resource the event is about (subscription id, order id…). */
    objectId: text("object_id"),
    /** Set once the event has been applied; null means received but skipped. */
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    /** Why it was skipped (stale, unknown team, unmodelled type). */
    skippedReason: text("skipped_reason"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    // Millisecond precision: this table is shaped so a future admin view can
    // keyset-page it, and the cursor round-trips `createdAt` through a JS
    // Date (ms); see schema/emails.ts.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("billing_events_team_created_idx").on(t.teamId, t.createdAt)],
);
export type BillingEvent = typeof billingEvents.$inferSelect;
```

- [ ] **Step 4: Export from the schema barrel**

In `apps/web/src/db/schema/index.ts`, add at the end (after `./worker-heartbeats`):

```ts
export * from "./billing";
```

- [ ] **Step 5: Generate and rename the migration**

Run: `cd apps/web && bun run db:generate`

Rename the generated `apps/web/drizzle/00NN_<random>.sql` to `apps/web/drizzle/0012_billing.sql` and change the matching entry's `tag` in `apps/web/drizzle/meta/_journal.json` from `00NN_<random>` to `0012_billing` (the 0009–0011 precedent). Read the SQL and confirm it contains exactly: `CREATE TABLE "team_billing"`, `CREATE TABLE "billing_usage"` with a composite `PRIMARY KEY("team_id","period_start")`, `CREATE TABLE "billing_events"`, two `ADD CONSTRAINT … FOREIGN KEY … ON DELETE cascade` (billing_usage and team_billing only — `billing_events.team_id` is deliberately FK-free: the row is inserted before the team is resolved, so an FK would make an unresolvable delivery unstorable and retried forever, and a cascade would delete the very idempotency keys the table exists to hold; `audit.ts` is the same shape), and `CREATE INDEX "billing_events_team_created_idx"`. It must not touch any existing table.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/billing-schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`

```bash
git add apps/web/src/db apps/web/drizzle apps/web/tests
git commit -m "feat(db): team_billing, billing_usage and billing_events tables"
```

---

## Task 3: `BILLING_ENABLED` and the provider env

One env block, one `billingConfig()` reader, and the guarantee that an invalid billing configuration fails at boot rather than at the first checkout.

**Files:**

- Create: `apps/web/src/services/billing/config.ts`
- Modify: `apps/web/src/env.schema.ts`, `.env.example`
- Test: `apps/web/tests/unit/env.test.ts` (extend), `apps/web/tests/unit/billing-config.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/tests/unit/env.test.ts` (it already builds a `BASE` object and calls `parseEnv`; reuse whatever that file names it — if the constant is not called `BASE`, use the existing name):

```ts
describe("billing env", () => {
  it("is off by default and needs no Polar credentials", () => {
    const e = parseEnv({ ...BASE });
    expect(e.BILLING_ENABLED).toBe(false);
    expect(e.BILLING_PROVIDER).toBe("polar");
    expect(e.BILLING_EVENT_NAME).toBe("email.sent");
  });

  it("refuses BILLING_ENABLED without a token and a webhook secret", () => {
    expect(() => parseEnv({ ...BASE, BILLING_ENABLED: "1" })).toThrow(
      /POLAR_ACCESS_TOKEN/,
    );
    expect(() =>
      parseEnv({ ...BASE, BILLING_ENABLED: "1", POLAR_ACCESS_TOKEN: "t" }),
    ).toThrow(/POLAR_WEBHOOK_SECRET/);
  });

  it("accepts a fully configured sandbox", () => {
    const e = parseEnv({
      ...BASE,
      BILLING_ENABLED: "true",
      POLAR_ACCESS_TOKEN: "polar_oat_x",
      POLAR_WEBHOOK_SECRET: "whsec_x",
      POLAR_SERVER: "sandbox",
      POLAR_METER_ID: "fb2f372a-f6a8-4697-93d6-adab7f76e4ad",
    });
    expect(e.BILLING_ENABLED).toBe(true);
    expect(e.POLAR_SERVER).toBe("sandbox");
    expect(e.POLAR_METER_ID).toBe("fb2f372a-f6a8-4697-93d6-adab7f76e4ad");
  });

  it("the fake provider needs no credentials but is refused in production", () => {
    expect(
      parseEnv({ ...BASE, BILLING_ENABLED: "1", BILLING_PROVIDER: "fake" })
        .BILLING_PROVIDER,
    ).toBe("fake");
    expect(() =>
      parseEnv({
        ...BASE,
        NODE_ENV: "production",
        BILLING_ENABLED: "1",
        BILLING_PROVIDER: "fake",
      }),
    ).toThrow(/BILLING_PROVIDER/);
  });
});
```

`apps/web/tests/unit/billing-config.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { parseEnv } from "@/env.schema";
import { billingConfig } from "@/services/billing/config";

const BASE = {
  APP_URL: "https://mail.example.com",
  APP_SECRET: "x".repeat(40),
  DATABASE_URL: "postgres://x/y",
};

afterEach(() => {
  for (const k of [
    "BILLING_ENABLED",
    "BILLING_PROVIDER",
    "POLAR_ACCESS_TOKEN",
    "POLAR_WEBHOOK_SECRET",
    "POLAR_METER_ID",
  ])
    delete process.env[k];
});

describe("billingConfig", () => {
  it("reports disabled when the flag is off", () => {
    Object.assign(process.env, BASE);
    expect(billingConfig(parseEnv({ ...BASE })).enabled).toBe(false);
  });

  it("carries the URLs the checkout and portal need", () => {
    const cfg = billingConfig(
      parseEnv({
        ...BASE,
        BILLING_ENABLED: "1",
        POLAR_ACCESS_TOKEN: "t",
        POLAR_WEBHOOK_SECRET: "s",
      }),
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.successUrl).toBe(
      "https://mail.example.com/app/settings/billing?checkout={CHECKOUT_ID}",
    );
    expect(cfg.returnUrl).toBe("https://mail.example.com/app/settings/billing");
    expect(cfg.eventName).toBe("email.sent");
    expect(cfg.meterId).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bunx vitest run --project unit tests/unit/env.test.ts tests/unit/billing-config.test.ts`
Expected: FAIL — the keys are not in the schema and `@/services/billing/config` does not exist.

- [ ] **Step 3: Extend `apps/web/src/env.schema.ts`**

Add to the `z.object({ … })`, after `LANDING_ENABLED`:

```ts
    /**
     * Hosted-service billing. Off by default: a self-hosted instance never
     * sees a Billing page, a checkout, or a provider webhook endpoint, and
     * `send-limits.ts` behaves exactly as it does without this phase.
     */
    BILLING_ENABLED: bool.default(false),
    /** `fake` is an in-memory provider for tests and e2e; never in production. */
    BILLING_PROVIDER: z.enum(["polar", "fake"]).default("polar"),
    /** Usage event name ingested to the provider; must match the meter's filter. */
    BILLING_EVENT_NAME: z.string().min(1).default("email.sent"),
    POLAR_ACCESS_TOKEN: z.string().min(1).optional(),
    POLAR_WEBHOOK_SECRET: z.string().min(1).optional(),
    POLAR_SERVER: z.enum(["sandbox", "production"]).default("production"),
    /**
     * Optional, display only: with it set the billing page can also show the
     * provider's own meter balance next to ours. Billing does not need it —
     * usage events are ingested by name, and the meter is configured by hand
     * in the Polar dashboard.
     */
    POLAR_METER_ID: z.string().min(1).optional(),
```

Chain two more refines onto the existing `.refine(…)` for the SMTP TLS pair:

```ts
  .refine(
    (e) =>
      !e.BILLING_ENABLED ||
      e.BILLING_PROVIDER === "fake" ||
      Boolean(e.POLAR_ACCESS_TOKEN),
    {
      message: "BILLING_ENABLED requires POLAR_ACCESS_TOKEN",
      path: ["POLAR_ACCESS_TOKEN"],
    },
  )
  .refine(
    (e) =>
      !e.BILLING_ENABLED ||
      e.BILLING_PROVIDER === "fake" ||
      Boolean(e.POLAR_WEBHOOK_SECRET),
    {
      message: "BILLING_ENABLED requires POLAR_WEBHOOK_SECRET",
      path: ["POLAR_WEBHOOK_SECRET"],
    },
  )
  .refine(
    (e) => e.NODE_ENV !== "production" || e.BILLING_PROVIDER !== "fake",
    {
      message: "BILLING_PROVIDER=fake is refused in production",
      path: ["BILLING_PROVIDER"],
    },
  );
```

- [ ] **Step 4: Write `apps/web/src/services/billing/config.ts`**

```ts
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
    // `{CHECKOUT_ID}` is substituted by the provider at redirect time.
    successUrl: `${base}${BILLING_PATH}?checkout={CHECKOUT_ID}`,
    returnUrl: `${base}${BILLING_PATH}`,
  };
}

/** Cheap guard for pages and routes that must 404 with billing off. */
export const billingEnabled = (): boolean => billingConfig().enabled;
```

- [ ] **Step 5: Document the variables**

Append to `.env.example`:

```bash
# ---- Billing (Phase 5, hosted service only) ----
# Off by default: self-hosted instances have no Billing page and no checkout.
#BILLING_ENABLED=false
# Organization access token and webhook signing secret from the Polar dashboard.
#POLAR_ACCESS_TOKEN=
#POLAR_WEBHOOK_SECRET=
# `sandbox` while developing; omit or `production` in prod.
#POLAR_SERVER=production
# Optional. Display only: shows Polar's own meter balance next to ours.
#POLAR_METER_ID=
# Must match the event name the Polar meter filters on.
#BILLING_EVENT_NAME=email.sent
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && bunx vitest run --project unit tests/unit/env.test.ts tests/unit/billing-config.test.ts`
Expected: PASS.

- [ ] **Step 7: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test`

```bash
git add apps/web .env.example
git commit -m "feat(billing): BILLING_ENABLED env plumbing and billingConfig()"
```

---

## Task 4: The provider seam and the fake provider

The interface first, with an in-memory implementation that every test and the e2e suite drive. Writing the fake before the Polar client is what proves the seam is really provider-agnostic — nothing in the interface may mention Polar.

**Files:**

- Create: `apps/web/src/services/billing/provider.ts`, `apps/web/src/services/billing/fake.ts`
- Test: `apps/web/tests/unit/billing-fake-provider.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/tests/unit/billing-fake-provider.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeProvider, type FakeProvider } from "@/services/billing/fake";

let p: FakeProvider;
beforeEach(() => {
  p = createFakeProvider();
});

describe("fake billing provider", () => {
  it("lists the three seeded plan products with their metadata", async () => {
    const products = await p.listPlanProducts();
    expect(products.map((x) => x.plan)).toEqual(["free", "pro", "scale"]);
    const pro = products.find((x) => x.plan === "pro")!;
    expect(pro).toMatchObject({
      includedEmails: 50000,
      overagePer1kCents: 40,
      priceCents: 1200,
      hasMeteredPrice: true,
    });
    expect(pro.productId).toMatch(/^prod_/);
  });

  it("creates a checkout URL carrying the product and the external customer", async () => {
    const { url } = await p.createCheckout({
      productId: "prod_pro",
      externalCustomerId: "org_1",
      successUrl: "https://x.io/done?checkout={CHECKOUT_ID}",
    });
    expect(url).toContain("prod_pro");
    expect(url).toContain("org_1");
  });

  it("creates a portal URL for an external customer", async () => {
    const { url } = await p.createPortalSession({
      externalCustomerId: "org_1",
      returnUrl: "https://x.io/back",
    });
    expect(url).toContain("org_1");
  });

  it("verifies a webhook the fake itself signed and rejects anything else", () => {
    const signed = p.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_1",
      externalCustomerId: "org_1",
      productId: "prod_pro",
      status: "active",
    });
    const ok = p.verifyWebhook(signed.body, signed.headers);
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.event.kind).toBe("subscription");
    if (ok.event.kind !== "subscription") throw new Error("unreachable");
    expect(ok.event.subscription.plan?.plan).toBe("pro");
    expect(ok.event.deliveryId).toBe(signed.deliveryId);

    const bad = p.verifyWebhook(signed.body, new Headers({}));
    expect(bad.ok).toBe(false);
  });

  it("records ingested usage and reports duplicates by externalId", async () => {
    const ev = {
      externalId: "org_1:2026-08-25T09:00:00.000Z",
      externalCustomerId: "org_1",
      name: "email.sent",
      count: 12,
      timestamp: new Date("2026-08-25T09:00:00Z"),
    };
    expect(await p.ingestUsage([ev])).toEqual({ inserted: 1, duplicates: 0 });
    expect(await p.ingestUsage([ev])).toEqual({ inserted: 0, duplicates: 1 });
    expect(p.ingested.get("org_1")).toBe(12);
  });

  it("can be made to fail so callers can be tested against an outage", async () => {
    p.failNext("provider is down");
    await expect(p.ingestUsage([])).rejects.toThrow("provider is down");
    // One failure only: the next call succeeds.
    await expect(p.ingestUsage([])).resolves.toEqual({
      inserted: 0,
      duplicates: 0,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project unit tests/unit/billing-fake-provider.test.ts`
Expected: FAIL — `@/services/billing/fake` does not exist.

- [ ] **Step 3: Write `apps/web/src/services/billing/provider.ts`**

```ts
import type { Plan, PlanMetadata } from "@sendsprite/shared";

/** A purchasable plan in the provider's catalog, resolved from its metadata. */
export interface PlanProduct extends PlanMetadata {
  productId: string;
  name: string;
  /** Fixed recurring price in cents. */
  priceCents: number;
  /** The product carries a metered price, so overage can be billed. */
  hasMeteredPrice: boolean;
}

/** A subscription, normalised. `plan` is null when the product is not ours. */
export interface ProviderSubscription {
  subscriptionId: string;
  customerId: string;
  /** Our team id, set as the provider's external customer id at checkout. */
  externalCustomerId: string | null;
  productId: string;
  /** Provider status verbatim; `isEntitledStatus` decides what it means. */
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** Newest of the payload's modified/created stamps; the ordering guard. */
  modifiedAt: Date;
  hasMeteredPrice: boolean;
  plan: PlanMetadata | null;
}

/**
 * A verified webhook, normalised. `deliveryId` is the provider's per-delivery
 * id (reused on retries) and is the only thing safe to deduplicate on — a
 * resource id is shared by several event types about the same object.
 */
export type ProviderEvent =
  | {
      kind: "subscription";
      deliveryId: string;
      type: string;
      subscription: ProviderSubscription;
    }
  | {
      kind: "order_paid";
      deliveryId: string;
      type: string;
      subscriptionId: string | null;
      externalCustomerId: string | null;
      paidAt: Date;
    }
  | { kind: "ignored"; deliveryId: string; type: string };

/** One rolled-up usage record. `externalId` makes redelivery a no-op. */
export interface UsageEvent {
  /** Deterministic per (team, bucket) so a retry cannot double-count. */
  externalId: string;
  externalCustomerId: string;
  name: string;
  count: number;
  timestamp: Date;
}

export type VerifyResult =
  { ok: true; event: ProviderEvent } | { ok: false; reason: string };

/** Thrown when billing is on but the provider cannot be reached or built. */
export class BillingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingUnavailableError";
  }
}

/**
 * Everything the app needs from a payment provider. Nothing here names Polar:
 * a second implementation (or a move into a private package) is a new file,
 * not a redesign. Implementations may throw; callers wrap.
 */
export interface BillingProvider {
  /** `"polar"`, `"fake"` — stored on `team_billing.provider`. */
  readonly id: string;
  /** Catalog products carrying our plan metadata, cheapest first. */
  listPlanProducts(): Promise<PlanProduct[]>;
  createCheckout(input: {
    productId: string;
    externalCustomerId: string;
    customerEmail?: string;
    successUrl: string;
    /** Copied onto the resulting subscription; carries the team id as a fallback. */
    metadata?: Record<string, string>;
  }): Promise<{ url: string }>;
  createPortalSession(input: {
    externalCustomerId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  /** Signature check + normalisation. Never throws; returns a reason instead. */
  verifyWebhook(body: string, headers: Headers): VerifyResult;
  ingestUsage(
    events: UsageEvent[],
  ): Promise<{ inserted: number; duplicates: number }>;
  /** The provider's own meter balance, when it can be read. Display only. */
  meterBalance?(externalCustomerId: string): Promise<number | null>;
}

/** Catalog order for the upgrade UI. */
export const PLAN_ORDER: Record<Plan, number> = { free: 0, pro: 1, scale: 2 };
```

- [ ] **Step 4: Write `apps/web/src/services/billing/fake.ts`**

```ts
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { planFromProductMetadata } from "@sendsprite/shared";
import type {
  BillingProvider,
  PlanProduct,
  ProviderSubscription,
  UsageEvent,
  VerifyResult,
} from "./provider";

const SECRET = "fake-billing-secret";

/** Mirrors the sandbox catalog so tests exercise the real metadata shape. */
const CATALOG: PlanProduct[] = [
  {
    productId: "prod_free",
    name: "Sendsprite Free",
    plan: "free",
    priceCents: 0,
    includedEmails: 3000,
    overagePer1kCents: 0,
    hasMeteredPrice: false,
  },
  {
    productId: "prod_pro",
    name: "Sendsprite Pro",
    plan: "pro",
    priceCents: 1200,
    includedEmails: 50000,
    overagePer1kCents: 40,
    hasMeteredPrice: true,
  },
  {
    productId: "prod_scale",
    name: "Sendsprite Scale",
    plan: "scale",
    priceCents: 4900,
    includedEmails: 300000,
    overagePer1kCents: 25,
    hasMeteredPrice: true,
  },
];

const PRODUCT_METADATA: Record<string, Record<string, unknown>> = {
  prod_free: { plan: "free", included_emails: 3000, overage_per_1k_cents: 0 },
  prod_pro: { plan: "pro", included_emails: 50000, overage_per_1k_cents: 40 },
  prod_scale: {
    plan: "scale",
    included_emails: 300000,
    overage_per_1k_cents: 25,
  },
};

const sign = (body: string) =>
  createHmac("sha256", SECRET).update(body).digest("hex");

export interface SignedEvent {
  body: string;
  headers: Headers;
  deliveryId: string;
}

export interface FakeSubscriptionInput {
  subscriptionId: string;
  externalCustomerId: string | null;
  productId: string;
  status: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
  modifiedAt?: Date;
  /** Force the metered flag independently of the catalog (overage-off tests). */
  hasMeteredPrice?: boolean;
  deliveryId?: string;
}

export interface FakeProvider extends BillingProvider {
  /** Units ingested per external customer, summed. */
  readonly ingested: Map<string, number>;
  /** Every `externalId` seen, in order. */
  readonly ingestedIds: string[];
  /** Build a signed payload the way the real provider would. */
  signSubscriptionEvent(type: string, sub: FakeSubscriptionInput): SignedEvent;
  signOrderPaidEvent(input: {
    subscriptionId: string | null;
    externalCustomerId: string | null;
    deliveryId?: string;
  }): SignedEvent;
  /** Make exactly the next provider call reject (outage tests). */
  failNext(message: string): void;
}

const MONTH_MS = 30 * 24 * 3600 * 1000;

export function createFakeProvider(): FakeProvider {
  const ingested = new Map<string, number>();
  const ingestedIds: string[] = [];
  const seen = new Set<string>();
  let failure: string | null = null;

  const boom = () => {
    if (failure === null) return;
    const message = failure;
    failure = null;
    throw new Error(message);
  };

  const signed = (payload: unknown, deliveryId: string): SignedEvent => {
    const body = JSON.stringify(payload);
    return {
      body,
      deliveryId,
      headers: new Headers({
        "webhook-id": deliveryId,
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-signature": sign(body),
      }),
    };
  };

  return {
    id: "fake",
    ingested,
    ingestedIds,

    async listPlanProducts() {
      boom();
      return CATALOG.map((p) => ({ ...p }));
    },

    async createCheckout({ productId, externalCustomerId }) {
      boom();
      return {
        url: `https://fake.billing.test/checkout/${productId}?customer=${encodeURIComponent(externalCustomerId)}`,
      };
    },

    async createPortalSession({ externalCustomerId }) {
      boom();
      return {
        url: `https://fake.billing.test/portal/${encodeURIComponent(externalCustomerId)}`,
      };
    },

    verifyWebhook(body, headers): VerifyResult {
      const id = headers.get("webhook-id");
      const sig = headers.get("webhook-signature");
      if (!id || !sig)
        return { ok: false, reason: "missing signature headers" };
      const expected = Buffer.from(sign(body));
      const given = Buffer.from(sig);
      if (expected.length !== given.length || !timingSafeEqual(expected, given))
        return { ok: false, reason: "bad signature" };
      const parsed = JSON.parse(body) as {
        type: string;
        data: Record<string, unknown>;
      };
      if (parsed.type.startsWith("subscription.")) {
        const d = parsed.data as unknown as FakeSubscriptionInput & {
          currentPeriodStart: string;
          currentPeriodEnd: string;
          modifiedAt: string;
        };
        const subscription: ProviderSubscription = {
          subscriptionId: d.subscriptionId,
          customerId: `cus_${d.externalCustomerId ?? "unknown"}`,
          externalCustomerId: d.externalCustomerId ?? null,
          productId: d.productId,
          status: d.status,
          currentPeriodStart: new Date(d.currentPeriodStart),
          currentPeriodEnd: new Date(d.currentPeriodEnd),
          cancelAtPeriodEnd: d.cancelAtPeriodEnd ?? false,
          modifiedAt: new Date(d.modifiedAt),
          hasMeteredPrice:
            d.hasMeteredPrice ??
            CATALOG.find((p) => p.productId === d.productId)?.hasMeteredPrice ??
            false,
          plan: planFromProductMetadata(PRODUCT_METADATA[d.productId]),
        };
        return {
          ok: true,
          event: {
            kind: "subscription",
            deliveryId: id,
            type: parsed.type,
            subscription,
          },
        };
      }
      if (parsed.type === "order.paid")
        return {
          ok: true,
          event: {
            kind: "order_paid",
            deliveryId: id,
            type: parsed.type,
            subscriptionId: (parsed.data.subscriptionId as string) ?? null,
            externalCustomerId:
              (parsed.data.externalCustomerId as string) ?? null,
            paidAt: new Date(),
          },
        };
      return {
        ok: true,
        event: { kind: "ignored", deliveryId: id, type: parsed.type },
      };
    },

    async ingestUsage(events: UsageEvent[]) {
      boom();
      let inserted = 0;
      let duplicates = 0;
      for (const e of events) {
        if (seen.has(e.externalId)) {
          duplicates++;
          continue;
        }
        seen.add(e.externalId);
        ingestedIds.push(e.externalId);
        ingested.set(
          e.externalCustomerId,
          (ingested.get(e.externalCustomerId) ?? 0) + e.count,
        );
        inserted++;
      }
      return { inserted, duplicates };
    },

    async meterBalance(externalCustomerId) {
      return ingested.get(externalCustomerId) ?? 0;
    },

    signSubscriptionEvent(type, sub) {
      const start = sub.currentPeriodStart ?? new Date();
      return signed(
        {
          type,
          data: {
            ...sub,
            currentPeriodStart: start.toISOString(),
            currentPeriodEnd: (
              sub.currentPeriodEnd ?? new Date(start.getTime() + MONTH_MS)
            ).toISOString(),
            modifiedAt: (sub.modifiedAt ?? start).toISOString(),
          },
        },
        sub.deliveryId ?? randomUUID(),
      );
    },

    signOrderPaidEvent(input) {
      return signed(
        { type: "order.paid", data: input },
        input.deliveryId ?? randomUUID(),
      );
    },

    failNext(message) {
      failure = message;
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && bunx vitest run --project unit tests/unit/billing-fake-provider.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test`

```bash
git add apps/web/src/services/billing apps/web/tests/unit
git commit -m "feat(billing): provider interface and an in-memory fake provider"
```

---

## Task 5: The Polar provider

The only file in the repo that knows Polar exists. `@polar-sh/sdk` is imported **lazily** inside the factory, so a self-hosted instance with `BILLING_ENABLED=false` never loads it.

**Files:**

- Create: `apps/web/src/services/billing/polar.ts`
- Modify: `apps/web/package.json`
- Test: `apps/web/tests/unit/billing-polar.test.ts`

- [ ] **Step 1: Add the dependency**

Run: `cd apps/web && bun add @polar-sh/sdk@^0.49.0 && cd ../.. && bun install`

- [ ] **Step 2: Write the failing test**

The test covers the two pure parts — catalog mapping and webhook normalisation — with the SDK's network calls left out entirely. `validateEvent` is real, so the signature path is genuinely exercised.

`apps/web/tests/unit/billing-polar.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Webhook } from "standardwebhooks";
import {
  createPolarProvider,
  normalisePolarSubscription,
  planProductsFrom,
} from "@/services/billing/polar";

const SECRET_B64 = Buffer.from("polar-test-secret").toString("base64");

const PRO_PRODUCT = {
  id: "b1a20e03-8474-49fb-aec2-d1b13cb7467e",
  name: "Sendsprite Pro",
  isArchived: false,
  isRecurring: true,
  metadata: { plan: "pro", included_emails: 50000, overage_per_1k_cents: 40 },
  prices: [
    { amountType: "fixed", priceAmount: 1200, isArchived: false },
    {
      amountType: "metered_unit",
      unitAmount: "0.040000000000",
      isArchived: false,
    },
  ],
};

const BESPOKE_PRODUCT = {
  id: "zzz",
  name: "Bespoke",
  isArchived: false,
  isRecurring: true,
  metadata: { note: "not one of ours" },
  prices: [{ amountType: "fixed", priceAmount: 999900, isArchived: false }],
};

describe("planProductsFrom", () => {
  it("keeps only products carrying our metadata", () => {
    expect(planProductsFrom([BESPOKE_PRODUCT, PRO_PRODUCT] as never)).toEqual([
      {
        productId: "b1a20e03-8474-49fb-aec2-d1b13cb7467e",
        name: "Sendsprite Pro",
        plan: "pro",
        priceCents: 1200,
        includedEmails: 50000,
        overagePer1kCents: 40,
        hasMeteredPrice: true,
      },
    ]);
  });

  it("orders the catalog cheapest plan first", () => {
    const free = {
      ...PRO_PRODUCT,
      id: "f",
      metadata: {
        plan: "free",
        included_emails: 3000,
        overage_per_1k_cents: 0,
      },
    };
    const scale = {
      ...PRO_PRODUCT,
      id: "s",
      metadata: {
        plan: "scale",
        included_emails: 300000,
        overage_per_1k_cents: 25,
      },
    };
    expect(
      planProductsFrom([scale, PRO_PRODUCT, free] as never).map((p) => p.plan),
    ).toEqual(["free", "pro", "scale"]);
  });

  it("drops archived products and ignores archived prices", () => {
    const archivedPrice = {
      ...PRO_PRODUCT,
      prices: [
        { amountType: "fixed", priceAmount: 1200, isArchived: false },
        { amountType: "metered_unit", unitAmount: "0.04", isArchived: true },
      ],
    };
    expect(planProductsFrom([archivedPrice] as never)[0]!.hasMeteredPrice).toBe(
      false,
    );
    expect(
      planProductsFrom([{ ...PRO_PRODUCT, isArchived: true }] as never),
    ).toEqual([]);
  });
});

describe("normalisePolarSubscription", () => {
  const sub = {
    id: "sub_1",
    customerId: "cus_1",
    productId: PRO_PRODUCT.id,
    status: "active",
    currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    modifiedAt: new Date("2026-08-02T00:00:00Z"),
    customer: { id: "cus_1", externalId: "org_abc" },
    product: PRO_PRODUCT,
    prices: PRO_PRODUCT.prices,
    metadata: {},
  };

  it("reads the team from the customer's external id and the plan from metadata", () => {
    const out = normalisePolarSubscription(sub as never);
    expect(out).toMatchObject({
      subscriptionId: "sub_1",
      externalCustomerId: "org_abc",
      status: "active",
      hasMeteredPrice: true,
      plan: { plan: "pro", includedEmails: 50000, overagePer1kCents: 40 },
    });
    expect(out.modifiedAt.toISOString()).toBe("2026-08-02T00:00:00.000Z");
  });

  it("falls back to subscription.metadata.teamId when there is no external id", () => {
    expect(
      normalisePolarSubscription({
        ...sub,
        customer: { id: "cus_1", externalId: null },
        metadata: { teamId: "org_fallback" },
      } as never).externalCustomerId,
    ).toBe("org_fallback");
  });

  it("falls back to createdAt when modifiedAt is null", () => {
    expect(
      normalisePolarSubscription({
        ...sub,
        modifiedAt: null,
      } as never).modifiedAt.toISOString(),
    ).toBe("2026-07-01T00:00:00.000Z");
  });

  it("plan is null for a product without our metadata", () => {
    expect(
      normalisePolarSubscription({ ...sub, product: BESPOKE_PRODUCT } as never)
        .plan,
    ).toBeNull();
  });
});

describe("polar webhook verification", () => {
  const provider = createPolarProvider({
    accessToken: "t",
    webhookSecret: SECRET_B64,
    server: "sandbox",
  });

  const deliver = (payload: unknown, id = "msg_1") => {
    const body = JSON.stringify(payload);
    const timestamp = new Date();
    return {
      body,
      headers: new Headers({
        "webhook-id": id,
        "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "webhook-signature": new Webhook(SECRET_B64).sign(id, timestamp, body),
      }),
    };
  };

  it("rejects a tampered body", () => {
    const { body, headers } = deliver({ type: "order.paid", data: {} });
    expect(provider.verifyWebhook(`${body} `, headers).ok).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(provider.verifyWebhook("{}", new Headers({})).ok).toBe(false);
  });

  it("normalises an unmodelled type to `ignored` rather than failing", () => {
    const { body, headers } = deliver({
      type: "benefit.created",
      data: { id: "ben_1" },
    });
    const r = provider.verifyWebhook(body, headers);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.event).toEqual({
      kind: "ignored",
      deliveryId: "msg_1",
      type: "benefit.created",
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project unit tests/unit/billing-polar.test.ts`
Expected: FAIL — `@/services/billing/polar` does not exist.

- [ ] **Step 4: Write `apps/web/src/services/billing/polar.ts`**

```ts
import { planFromProductMetadata, type PlanMetadata } from "@sendsprite/shared";
import {
  BillingUnavailableError,
  PLAN_ORDER,
  type BillingProvider,
  type PlanProduct,
  type ProviderSubscription,
  type UsageEvent,
  type VerifyResult,
} from "./provider";

/**
 * The only module that knows the provider is Polar. `@polar-sh/sdk` is
 * imported lazily inside `client()` so an instance with BILLING_ENABLED=false
 * never loads it, and moving this file into a private package later needs no
 * change anywhere else.
 *
 * Polar's own types are not imported: they are re-declared here, narrowed to
 * the fields we read, so a minor SDK release cannot break the build over a
 * field we never touch.
 */

interface PolarPrice {
  amountType?: string;
  priceAmount?: number | null;
  unitAmount?: string | null;
  isArchived?: boolean;
}
interface PolarProduct {
  id: string;
  name: string;
  isArchived?: boolean;
  metadata?: unknown;
  prices?: PolarPrice[];
}
interface PolarSubscription {
  id: string;
  customerId: string;
  productId: string;
  status: string;
  currentPeriodStart: Date | string;
  currentPeriodEnd: Date | string;
  cancelAtPeriodEnd: boolean;
  createdAt: Date | string;
  modifiedAt: Date | string | null;
  customer?: { id: string; externalId?: string | null };
  product?: PolarProduct;
  prices?: PolarPrice[];
  metadata?: Record<string, unknown>;
}

export interface PolarOptions {
  accessToken: string;
  webhookSecret: string;
  server: "sandbox" | "production";
  eventName?: string;
  meterId?: string | null;
}

const live = (p: PolarPrice) => p.isArchived !== true;
const hasMetered = (prices: PolarPrice[] | undefined) =>
  (prices ?? []).some((p) => live(p) && p.amountType === "metered_unit");
const fixedCents = (prices: PolarPrice[] | undefined) =>
  (prices ?? []).find((p) => live(p) && p.amountType === "fixed")
    ?.priceAmount ?? 0;
const asDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));

/**
 * Catalog to plan products. A product without our metadata is not one of
 * ours and is dropped, so a bespoke enterprise product living in the same
 * organization never appears as a self-serve upgrade.
 */
export function planProductsFrom(products: PolarProduct[]): PlanProduct[] {
  const out: PlanProduct[] = [];
  for (const p of products) {
    if (p.isArchived === true) continue;
    const meta = planFromProductMetadata(p.metadata);
    if (!meta) continue;
    out.push({
      productId: p.id,
      name: p.name,
      ...meta,
      priceCents: fixedCents(p.prices),
      hasMeteredPrice: hasMetered(p.prices),
    });
  }
  return out.sort((a, b) => PLAN_ORDER[a.plan] - PLAN_ORDER[b.plan]);
}

/**
 * Polar subscription to `ProviderSubscription`. The team id is the customer's
 * `externalId`, set at checkout; `metadata.teamId`, copied from the checkout
 * onto the subscription, is the belt-and-braces fallback for a customer
 * created some other way. `modifiedAt` falls back to `createdAt` — a
 * just-created subscription has none, and the ordering guard needs a real
 * timestamp.
 */
export function normalisePolarSubscription(
  s: PolarSubscription,
): ProviderSubscription {
  const plan: PlanMetadata | null = planFromProductMetadata(
    s.product?.metadata,
  );
  const teamId =
    s.customer?.externalId ??
    (typeof s.metadata?.teamId === "string" ? s.metadata.teamId : null);
  return {
    subscriptionId: s.id,
    customerId: s.customerId,
    externalCustomerId: teamId,
    productId: s.productId,
    status: s.status,
    currentPeriodStart: asDate(s.currentPeriodStart),
    currentPeriodEnd: asDate(s.currentPeriodEnd),
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    modifiedAt: asDate(s.modifiedAt ?? s.createdAt),
    hasMeteredPrice: hasMetered(s.prices ?? s.product?.prices),
    plan,
  };
}

/** Types we act on. Everything else verifies and is recorded as ignored. */
const SUBSCRIPTION_TYPES = new Set([
  "subscription.created",
  "subscription.updated",
  "subscription.active",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.revoked",
  "subscription.past_due",
]);

/** Events per ingest call. Conservative; Polar's own limit is higher. */
export const INGEST_CHUNK = 500;

/** Structural view of the SDK, so this module compiles without a static import. */
interface PolarSdk {
  products: {
    list(
      q: Record<string, unknown>,
    ): Promise<AsyncIterable<{ result: { items: PolarProduct[] } }>>;
  };
  checkouts: { create(i: Record<string, unknown>): Promise<{ url: string }> };
  customerSessions: {
    create(i: Record<string, unknown>): Promise<{ customerPortalUrl: string }>;
  };
  events: {
    ingest(i: {
      events: Record<string, unknown>[];
    }): Promise<{ inserted: number; duplicates?: number }>;
  };
  customerMeters: {
    list(q: Record<string, unknown>): Promise<
      AsyncIterable<{
        result: { items: { meterId: string; balance: number }[] };
      }>
    >;
  };
}
type ValidateEvent = (
  body: string,
  headers: Record<string, string>,
  secret: string,
) => { type: string; data: unknown };

export function createPolarProvider(opts: PolarOptions): BillingProvider {
  const eventName = opts.eventName ?? "email.sent";
  let loading:
    Promise<{ polar: PolarSdk; validate: ValidateEvent }> | undefined;
  // `verifyWebhook` must be synchronous (the interface says so), so the
  // validator is cached here by the first successful load. The webhook route
  // calls `getBillingProvider()` — which awaits nothing lazy — before every
  // delivery, and `ready()` below makes that first call warm the cache.
  let validateSync: ValidateEvent | undefined;

  function client() {
    loading ??= (async () => {
      const [sdkModule, webhooksModule] = await Promise.all([
        import("@polar-sh/sdk"),
        import("@polar-sh/sdk/webhooks"),
      ]);
      const validate = webhooksModule.validateEvent as unknown as ValidateEvent;
      validateSync = validate;
      return {
        polar: new sdkModule.Polar({
          accessToken: opts.accessToken,
          server: opts.server,
        }) as unknown as PolarSdk,
        validate,
      };
    })().catch((e) => {
      loading = undefined;
      throw new BillingUnavailableError(
        `Polar SDK could not be loaded: ${(e as Error).message}`,
      );
    });
    return loading;
  }

  return {
    id: "polar",

    /** Awaited by `getBillingProvider()` so `verifyWebhook` is never cold. */
    async ready() {
      await client();
    },

    async listPlanProducts() {
      const { polar } = await client();
      const items: PolarProduct[] = [];
      // Speakeasy list methods return a page iterator; each page carries
      // `result.items`. See the note under this task if the shape differs.
      for await (const page of await polar.products.list({
        isArchived: false,
        isRecurring: true,
        limit: 100,
      }))
        items.push(...page.result.items);
      return planProductsFrom(items);
    },

    async createCheckout({
      productId,
      externalCustomerId,
      customerEmail,
      successUrl,
      metadata,
    }) {
      const { polar } = await client();
      const r = await polar.checkouts.create({
        products: [productId],
        externalCustomerId,
        ...(customerEmail && { customerEmail }),
        successUrl,
        // Copied onto the subscription; the webhook reads it if a customer
        // somehow arrives without an external id.
        metadata: { teamId: externalCustomerId, ...metadata },
      });
      return { url: r.url };
    },

    async createPortalSession({ externalCustomerId, returnUrl }) {
      const { polar } = await client();
      const r = await polar.customerSessions.create({
        externalCustomerId,
        returnUrl,
      });
      return { url: r.customerPortalUrl };
    },

    verifyWebhook(body, headers): VerifyResult {
      const deliveryId = headers.get("webhook-id");
      if (!deliveryId) return { ok: false, reason: "missing webhook-id" };
      if (!validateSync) {
        // Warm the cache for the retry; the provider will redeliver.
        void client().catch(() => undefined);
        return { ok: false, reason: "provider SDK not loaded" };
      }
      let event: { type: string; data: unknown };
      try {
        event = validateSync(
          body,
          {
            "webhook-id": deliveryId,
            "webhook-timestamp": headers.get("webhook-timestamp") ?? "",
            "webhook-signature": headers.get("webhook-signature") ?? "",
          },
          opts.webhookSecret,
        );
      } catch (e) {
        return {
          ok: false,
          reason: (e as Error).message || "invalid signature",
        };
      }
      if (SUBSCRIPTION_TYPES.has(event.type))
        return {
          ok: true,
          event: {
            kind: "subscription",
            deliveryId,
            type: event.type,
            subscription: normalisePolarSubscription(
              event.data as PolarSubscription,
            ),
          },
        };
      if (event.type === "order.paid") {
        const o = event.data as {
          subscriptionId?: string | null;
          customer?: { externalId?: string | null };
        };
        return {
          ok: true,
          event: {
            kind: "order_paid",
            deliveryId,
            type: event.type,
            subscriptionId: o.subscriptionId ?? null,
            externalCustomerId: o.customer?.externalId ?? null,
            paidAt: new Date(),
          },
        };
      }
      return {
        ok: true,
        event: { kind: "ignored", deliveryId, type: event.type },
      };
    },

    async ingestUsage(events: UsageEvent[]) {
      if (events.length === 0) return { inserted: 0, duplicates: 0 };
      const { polar } = await client();
      let inserted = 0;
      let duplicates = 0;
      for (let i = 0; i < events.length; i += INGEST_CHUNK) {
        const chunk = events.slice(i, i + INGEST_CHUNK);
        const r = await polar.events.ingest({
          events: chunk.map((e) => ({
            name: e.name || eventName,
            externalCustomerId: e.externalCustomerId,
            // Polar deduplicates on `external_id`, which is exactly what makes
            // re-sending a rollup after a failed call safe.
            externalId: e.externalId,
            timestamp: e.timestamp,
            metadata: { count: e.count },
          })),
        });
        inserted += r.inserted;
        duplicates += r.duplicates ?? 0;
      }
      return { inserted, duplicates };
    },

    async meterBalance(externalCustomerId) {
      if (!opts.meterId) return null;
      try {
        const { polar } = await client();
        for await (const page of await polar.customerMeters.list({
          externalCustomerId,
          meterId: opts.meterId,
          limit: 1,
        })) {
          const row = page.result.items[0];
          if (row) return row.balance;
        }
        return null;
      } catch {
        // Display only: a provider hiccup must not break the billing page.
        return null;
      }
    },
  };
}
```

Add the optional warm-up hook to the interface in `apps/web/src/services/billing/provider.ts`:

```ts
  /** Optional: pre-load anything `verifyWebhook` needs. Awaited by the factory. */
  ready?(): Promise<void>;
```

and await it in `getBillingProvider` (Task 6's `index.ts`), right before returning a freshly built provider:

```ts
  const provider = createPolarProvider({ … });
  await provider.ready?.();
  return (g.__sendspriteBilling = provider);
```

> The one uncertainty in this task, and the only place to adjust: the page shape of `polar.products.list` / `polar.customerMeters.list` in `@polar-sh/sdk@0.49.0`. The code assumes the Speakeasy page iterator (`for await (const page of await …) page.result.items`). If it differs, change the two `for await` loops only — `planProductsFrom` takes a plain array and is what the tests drive, so nothing else moves.

### What Task 5 actually shipped — deviations from the draft above

The page-iterator shape was right; `for await (const page of await …) page.result.items` is
exactly what `@polar-sh/sdk@0.49.0` returns for both list calls, and neither loop moved. What
did change, all of it forced by reading the installed SDK:

1. **`validateEvent` takes the _raw_ secret, not base64.** It base64-encodes what it is given
   before constructing the Standard Webhooks key. So `POLAR_WEBHOOK_SECRET` holds the raw
   dashboard secret, and a test that signs a delivery must build its `Webhook` with the
   **base64 form** of that same string. The draft test did the opposite and could never have
   produced a valid signature.
2. **`validateEvent` also _parses_, strictly, per event type**, and throws
   `SDKValidationError` on an unknown type or a payload the pinned models do not match — so
   the draft's expectation that `benefit.created` with `{ id: "ben_1" }` normalises to
   `ignored` cannot come from a bare try/catch. `verifyWebhook` now classifies the failure:
   a `WebhookVerificationError` (bad signature, missing headers, timestamp outside the 5-minute
   replay window) is `{ ok: false }`; anything else happened _after_ the signature passed, so
   the delivery is authentic and merely unmodelled — it becomes `ignored`, because refusing
   would make Polar retry a delivery that can never succeed. The one exception is a
   **subscription** type, where silently dropping the event loses an entitlement change: that
   returns `{ ok: false }` so it retries and shows up in Polar's failed-delivery list.
3. **`overageCapCents`** is populated off the metered price (amendment C).
4. **`polarUsageEvents(events, fallbackName)` is extracted and exported** so the ingest
   mapping — `metadata.count`, which is what the org's `emails` meter sums — is unit-testable
   without a network. `ingestUsage` chunks the mapped array.
   4b. **The lazy loader is split in two.** `@polar-sh/sdk/webhooks` (payload schemas +
   `standardwebhooks`, none of the HTTP client machinery) loads on its own for the webhook
   path, and the package index loads only when an API call is made. `ready()` warms the
   validator alone — the one path where a cold start becomes refused deliveries.
   4c. **`createPolarProvider` refuses to be built without a webhook secret.** Empirically
   verified: `standardwebhooks` builds its key in the `Webhook` constructor, which
   `validateEvent` runs _outside_ its own try, so an empty secret throws a plain
   `Error("Secret can't be empty.")` rather than a `WebhookVerificationError`. Under the
   classification in item 2 that reads as "authentic but unmodelled", so every forged
   delivery would have come back `ignored` — 200, a stored event row, no HMAC ever checked,
   and invisible, because subscription events would still refuse and the instance would look
   healthy. `env.schema.ts` already refuses `BILLING_ENABLED` without the secret; this is the
   second lock, since `billingConfig().webhookSecret` is nullable.
   4d. **The refusal rule keys off the `subscription.` prefix, not the modelled set**, so a
   subscription type Polar ships after this SDK was pinned is still refused rather than
   dropped. `SUBSCRIPTION_TYPES` and `isSubscriptionType()` now live in `provider.ts`, and the
   fake dispatches on the same set — otherwise a test written against an invented
   `subscription.foo` would pass against the fake and be refused in production.
5. **The SDK client is typed with `import type { Polar } from "@polar-sh/sdk"`** rather than a
   hand-rolled structural `PolarSdk`. A type-only import is erased, so the lazy-load guarantee
   is untouched, and the four call sites are now checked against the real request/response
   types. The **payload** shapes (`PolarPrice`, `PolarProduct`, `PolarSubscription`) are still
   re-declared and are now _exported_, so the pure functions can be driven from a test with a
   plain typed object instead of `as never`. `unitAmount` was dropped from `PolarPrice` (never
   read) and `capAmount` added.
6. **`order.paid` reports the payload's own `timestamp` as `paidAt`**, not `new Date()`.
7. **`standardwebhooks` is a devDependency of `apps/web`**, as this task's step 5 anticipated:
   it is not hoisted where the test can resolve it otherwise.
8. The `ready?()` hook landed on `BillingProvider` as drafted. `verifyWebhook` returns
   `{ ok: false, reason: "provider SDK not loaded" }` if called cold, and warms the cache for
   the redelivery.

Step 5's expected count is **28 tests**, not 10: the extra ones cover the replay window, a
signature replayed under a new delivery id, the cold-start path, the ingest mapping, the
`SUBSCRIPTION_STATUSES` pin from amendment D, the empty-secret refusal, the
prefix-based subscription refusal, the `order.paid` team-id fallback, and two wire-format
fixtures (a real
`subscription.updated` and a real `order.paid`, in Polar's own snake_case JSON) that prove the
pinned SDK parses a genuine payload into the fields the billing service reads.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && bunx vitest run --project unit tests/unit/billing-polar.test.ts`
Expected: PASS (10 tests). `standardwebhooks` arrives transitively with `@polar-sh/sdk`; if the test cannot resolve it, add it as a devDependency of `apps/web` rather than reaching into `node_modules`.

- [ ] **Step 6: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test`

```bash
git add apps/web/src/services/billing apps/web/tests/unit apps/web/package.json bun.lock
git commit -m "feat(billing): Polar provider — catalog, checkout, portal, webhook verification, usage ingest"
```

---

## Openers discovered during Phase 5 (fold into the status block in Task 12)

- **Metered emails are never un-metered.** An email that flips from a billable state into a
  non-billable terminal one (`failed`, `cancelled`) more than 30 minutes after its hour closed
  has already been reported to the provider, and nothing reverses it. Small and bounded, but it
  is a customer being charged for a message that did not go out — worth either a compensating
  adjustment or an explicit "we bill on acceptance" line in the docs.
- **`billing_usage.reported_units` can drift upward.** It is a local display counter: if an
  ingest succeeds but the following `commitRollup` write fails, the next run re-emits (the
  provider dedupes, so the invoice is safe) and re-adds locally. The billed figure is the
  provider's and `teamBillingState.used` is counted live from `emails`, so nothing user-facing
  is wrong — but the column should not be mistaken for a billing source of truth.
- **Catch-up cost for a stale stored period.** A team whose stored `period_start` is far in the
  past scans up to 168 buckets per sweep until it catches up. Bounded and quiet, but if that
  ever matters, clamping `from` forward is the lever.
- **One `team_billing` select per message on the send hot path.** With billing on,
  `resolveTeamCaps` reads the billing row inside `checkTeamCaps`, and `createBatch` loops
  `createEmail` — so a 100-message batch issues 100 extra selects. It matches the existing
  uncached `team_settings` read, so it is not a new pattern, but a per-request memo (or
  resolving caps once per batch) is the obvious win if send latency ever matters.
- **`checkTeamCaps` now requires a fully valid environment**, even with billing off, because
  `resolveTeamCaps` reads env through `billingEnabled()`. The app can't boot without a valid env
  anyway, so this only bites tests that previously needed none — one existing test file already
  had to gain `APP_URL`. Worth knowing before it surprises someone.
- **Embedded-Postgres starvation under full-suite load.** Two different integration files have
  now failed once each in a full 36-file run at `maxWorkers: 4` and passed in isolation:
  `retention.test.ts` hit the 180 s hook timeout in `startPg()`'s `beforeAll`, and the
  concurrent-claim test below failed with `not_claimed`. Two distinct files pointing at
  start-up starvation suggests the cause is the harness, not the tests — worth capping workers
  for the integration project, or sharing one Postgres instance across files, before CI starts
  failing intermittently on unrelated PRs.
- **Vitest must be run from `apps/web`.** `bunx vitest --root apps/web` from the repo root
  breaks `startPg`'s embedded Postgres. Worth a line in the contributing docs.
- **Flaky concurrent-claim test.** `apps/web/tests/integration/email-send.test.ts` →
  `sendQueuedEmail > two concurrent attempts: exactly one SES call, one sent event, the loser is
skipped` failed once with `not_claimed` during a full 35-file integration run under load, and
  passed both in isolation (15/15) and on a full re-run (226/226). Phase 3 code, unrelated to
  billing. A race test that fails intermittently under load will make CI untrustworthy — it needs
  an owner before it starts failing on other people's PRs.

## Amendment before Task 6 — decisions taken after this plan was written

These override the task bodies below where they conflict. Implement them as part of the
task they touch.

**A. `past_due` gets a 7-day grace, then Free caps.** As drafted, Task 6's `entitlementFrom`
treats `past_due` as entitled indefinitely, which means a dead card buys unlimited sending
until the provider eventually flips the status. Instead: while `status === "past_due"`, keep
the paid caps until `pastDueAt + 7 days`, and past that point resolve the Free entitlement.
`pastDueAt` is already stamped and cleared by the webhook handler, so this is a read-path
change: add `pastDueAt` to `BillingSnapshot`'s selection and to `Entitlement`, apply the
window in `entitlementFrom`, and carry it into `teamBillingState` so the dashboard can render
a deadline. `isEntitledStatus("past_due")` stays `true` — the grace clock lives with the
entitlement, not the status.

**B-bis (refinement, supersedes the literal reading of B).** The refusal applies to _plan
resolution_, not to _status_. A subscription's status — `canceled`, `revoked`, `unpaid`,
`past_due` — does not depend on product metadata being well-formed, and dropping such an event
means a churned customer keeps paid caps indefinitely until someone notices the dashboard typo.
So on malformed-but-claiming metadata: **apply the status and period as normal, and withhold
only the plan fields** (`plan`, `includedEmails`, `overagePer1kCents`), keeping the previous
values. Log just as loudly. Only a payload that is structurally unusable (no subscription id,
empty status, non-finite dates) is skipped outright.

**B. Refuse to downgrade on malformed metadata.** Task 1 exports `claimsPlanMetadata()`.
Where `applySubscription` currently writes `FREE_PLAN_METADATA` whenever
`planFromProductMetadata()` returns `null`, split the two cases: if the product does not
claim to be ours, the existing behaviour is right; if it claims a known `plan` but the rest
of the metadata is malformed, log loudly naming the product and the team, leave the previous
snapshot intact, and do not overwrite a paid entitlement with Free on the strength of a bad
string.

**C. Overage ceilings exist on the Polar price, not in metadata.** Pro is capped at $200 of
overage per cycle and Scale at $500 via `cap_amount` on their metered prices. Nothing in the
app enforces this; it is provider configuration. Surface it if it is cheaply available on the
subscription payload, but do not model it in `PlanMetadata`.

_Settled in Task 5: it is cheaply available, so it is surfaced (as a **required**
`number | null`, since every implementation can answer "is there a ceiling" and two states
spare a renderer an unreachable case)._ `capAmount` sits on the same
`ProductPriceMeteredUnit` object the `hasMeteredPrice` check already has in hand, on both
`subscription.prices` and `product.prices`. `ProviderSubscription` therefore gained an optional
`overageCapCents?: number | null`, the Polar provider populates it, and the fake grew a matching
per-product default (Pro 20 000, Scale 50 000) plus a `FakeSubscriptionInput.overageCapCents`
override. `null` means "metered but uncapped" or "no metered price at all". `PlanProduct` was
deliberately **not** extended — the catalog listing has no consumer for a cap in this phase.
The field is display-only; no cap is enforced anywhere in this app.

**E. Timestamp precision and the metering key.** `billing_usage.period_start`,
`team_billing.period_start` and `team_billing.provider_modified_at` are `precision: 3`
(migration 0012 was amended in place, pre-deployment). Beyond precision, the _live_ hazard is
that `entitlementFrom` substitutes `calendarMonth(now)` whenever the stored period does not
contain `now` — a renewal webhook that has not landed yet, or a non-entitling status. If
Task 9 keys `billing_usage` off whatever `entitlementFrom` returned, one run keys on the
provider period and the next on the calendar month: a second usage row accumulates for hours
the first already counted, the watermark resets, and the whole period is re-bucketed. The
provider-side `usageExternalId` dedupe protects the invoice, not our numbers. **Key
`billing_usage` on the stored `team_billing.period_start`** and treat the calendar-month
fallback as an entitlement-only concept.

**F. Webhook application is transactional.** `billing_events` insert + apply + mark must
commit in one transaction. Otherwise a crash between the insert and the `applied_at` update
leaves a row that short-circuits every retry as a duplicate for an event that was never
applied — a silently lost subscription change. Polar retries on a non-2xx, so a rolled-back
delivery is simply redelivered. `payload` stays the `{ type }` stub: a debugging aid, not a
replay record, and deliberately not the raw body, which would put customer PII in a table with
no purge story.

**G. Guard the `past_due` clear.** The `order_paid` branch must not clear `pastDueAt`
unconditionally. A late or replayed `order.paid` for an earlier invoice, arriving after the
subscription has gone `past_due` again, would reset the grace clock in amendment A and buy
another week of paid caps on a dead card. `team_billing.last_order_paid_at` exists for this:
only clear when the order is newer.

**H. Typed upsert `set` object.** `onConflictDoUpdate({ set })` takes a `Partial`, so an upsert
that omits `includedEmails` compiles and leaves a stale allowance across a plan change. Type
the shared object as `Required<Pick<typeof teamBilling.$inferInsert, "plan" | "includedEmails" |
"overagePer1kCents" | "status" | "periodStart" | "periodEnd" | "providerModifiedAt">> &
Partial<typeof teamBilling.$inferInsert>` so an omission is caught at the seam.

**I. `getBillingProvider()` must await `provider.ready?.()`.** The Polar provider lazy-loads
its SDK so `BILLING_ENABLED=false` never pays for the import. A cold `verifyWebhook` therefore
returns `{ ok: false, reason: "provider SDK not loaded" }` and warms the cache for the
redelivery. If Task 6 does not await `ready?.()` when constructing the provider, **every first
webhook after a cold start is refused** — recoverable, since the provider retries, but it turns
each deploy into a burst of failed deliveries.

**J. `verifyWebhook`'s ignored-vs-refused split (Task 5's policy, adopted).** A signature,
missing-header or replay-window failure is `{ ok: false }`. A throw _after_ the signature
passed means the delivery is authentic but unmodelled, so it is `ignored` — refusing would make
the provider retry it forever. The exception is `subscription.*`: a payload that fails to parse
is refused, because silently dropping one loses an entitlement change, and a refused delivery
is at least visible in the provider's dashboard.

**D. Subscription-status list — RESOLVED, no change needed.** The suspicion was wrong:
`SubscriptionStatus` in `@polar-sh/sdk@0.49.0` is exactly the eight names already in
`SUBSCRIPTION_STATUSES`, in the same order. `paused` _is_ a real Polar status (the payload
carries `pause_at_period_end`, `paused_at`, `resumes_at`); the set resembles Stripe's because
Polar's model does. A test in `apps/web` pins the constant to the SDK enum, keeping
`packages/shared` free of a provider dependency. Original note follows for context:
During Task 5, diff it against `SubscriptionStatus` in `@polar-sh/sdk` and correct both the
constant and this plan. The constant is documentation only: the DB column is plain `text` and
`BillingStateObject.status` is `z.string()`, so an unmodelled status is stored verbatim and is
non-entitling by construction.

_Settled in Task 5: the suspicion was wrong and nothing changed._ `SubscriptionStatus` in
`@polar-sh/sdk@0.49.0` is exactly `incomplete`, `incomplete_expired`, `trialing`, `active`,
`past_due`, `canceled`, `unpaid`, `paused` — the same eight names in the same order.
`paused` **is** a Polar status: the subscription payload carries `pause_at_period_end`,
`paused_at` and `resumes_at` to go with it. The list resembles Stripe's because Polar's own
model does. The constant's comment now records the diff, and
`apps/web/tests/unit/billing-polar.test.ts` asserts the two are equal so a later SDK bump that
moves the set fails a test instead of rotting a comment. The assertion lives in `apps/web`
because `@sendsprite/shared` must stay free of a provider dependency. Note the SDK's enum is
itself open (`OpenEnum`), which is the same tolerance the plain `text` column gives us.

## Task 6: The billing service — state, plan resolution, event application

The provider-agnostic core: pick a provider, resolve a team's entitlement, and apply a verified webhook idempotently and safely against out-of-order delivery.

**Files:**

- Create: `apps/web/src/services/billing/plans.ts`, `apps/web/src/services/billing/usage.ts` (partial; Task 9 completes it), `apps/web/src/services/billing/index.ts`
- Test: `apps/web/tests/unit/billing-plans.test.ts`, `apps/web/tests/integration/billing-webhook.test.ts`

- [ ] **Step 1: Write the failing unit test for entitlement resolution**

`apps/web/tests/unit/billing-plans.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  FREE_ENTITLEMENT,
  calendarMonth,
  entitlementFrom,
} from "@/services/billing/plans";

const NOW = new Date("2026-08-25T12:00:00Z");

const row = {
  plan: "pro" as const,
  status: "active",
  includedEmails: 50000,
  overagePer1kCents: 40,
  overageEnabled: true,
  cancelAtPeriodEnd: false,
  periodStart: new Date("2026-08-10T00:00:00Z"),
  periodEnd: new Date("2026-09-10T00:00:00Z"),
};

describe("calendarMonth", () => {
  it("is the UTC month containing `now`, half-open", () => {
    expect(calendarMonth(NOW)).toEqual({
      start: new Date("2026-08-01T00:00:00.000Z"),
      end: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(calendarMonth(new Date("2026-12-31T23:59:59Z")).end).toEqual(
      new Date("2027-01-01T00:00:00.000Z"),
    );
  });
});

describe("entitlementFrom", () => {
  it("no row: free, hard-capped at 3 000 over the UTC month", () => {
    expect(entitlementFrom(undefined, NOW)).toEqual(FREE_ENTITLEMENT(NOW));
    expect(FREE_ENTITLEMENT(NOW)).toMatchObject({
      plan: "free",
      monthlyCap: 3000,
      overageEnabled: false,
      managed: false,
      status: null,
    });
  });

  it("an entitled subscription with a metered price has no monthly cap", () => {
    const e = entitlementFrom(row, NOW);
    expect(e).toMatchObject({
      plan: "pro",
      includedEmails: 50000,
      monthlyCap: null,
      overageEnabled: true,
      managed: true,
    });
    expect(e.periodStart).toEqual(row.periodStart);
    expect(e.periodEnd).toEqual(row.periodEnd);
  });

  it("without a metered price the include becomes a hard cap", () => {
    expect(
      entitlementFrom({ ...row, overageEnabled: false }, NOW).monthlyCap,
    ).toBe(50000);
  });

  it("past_due keeps the plan; canceled and unpaid fall back to free", () => {
    expect(entitlementFrom({ ...row, status: "past_due" }, NOW).plan).toBe(
      "pro",
    );
    for (const status of ["canceled", "unpaid", "incomplete"])
      expect(entitlementFrom({ ...row, status }, NOW)).toMatchObject({
        plan: "free",
        monthlyCap: 3000,
        managed: true,
      });
  });

  it("a stale period (now outside it) falls back to the UTC month", () => {
    // A renewal webhook that never arrived must not hand out an empty window,
    // and with it unlimited sending.
    const e = entitlementFrom(
      {
        ...row,
        periodStart: new Date("2026-06-10T00:00:00Z"),
        periodEnd: new Date("2026-07-10T00:00:00Z"),
      },
      NOW,
    );
    expect(e.periodStart).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(e.periodEnd).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    expect(e.plan).toBe("pro");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project unit tests/unit/billing-plans.test.ts`
Expected: FAIL — `@/services/billing/plans` does not exist.

- [ ] **Step 3: Write `apps/web/src/services/billing/plans.ts`**

```ts
import { eq } from "drizzle-orm";
import {
  FREE_PLAN_METADATA,
  isEntitledStatus,
  type Plan,
} from "@sendsprite/shared";
import { db } from "@/db";
import { teamBilling, type TeamBilling } from "@/db/schema";

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
}

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
>;

/**
 * Snapshot to entitlement. Pure, so the interesting cases are unit-tested:
 *
 * - No row, or a status that does not entitle (`canceled`, `unpaid`,
 *   `incomplete`): the free plan's caps. `managed` stays true when a row
 *   exists, so the UI can still offer the customer portal.
 * - Entitled with a metered price: no monthly cap. The customer has agreed to
 *   pay for the excess and blocking their sending would be the wrong failure.
 * - Entitled without one: the include becomes a hard cap. This is what makes
 *   fixed-tier billing work on its own, before metered pricing is switched on.
 * - A period that no longer contains `now` (a renewal webhook that never
 *   arrived): fall back to the UTC month, so a stale row can never produce an
 *   empty window and with it unlimited sending.
 */
export function entitlementFrom(
  row: BillingSnapshot | undefined,
  now: Date,
): Entitlement {
  if (!row) return FREE_ENTITLEMENT(now);
  const fresh =
    row.periodStart.getTime() <= now.getTime() &&
    now.getTime() < row.periodEnd.getTime();
  const window = fresh
    ? { start: row.periodStart, end: row.periodEnd }
    : calendarMonth(now);
  if (!isEntitledStatus(row.status))
    return {
      ...FREE_ENTITLEMENT(now),
      status: row.status,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      managed: true,
    };
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
  };
}

/** `team_billing` row for a team, or undefined. */
export async function billingRow(
  teamId: string,
): Promise<TeamBilling | undefined> {
  const [row] = await db()
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
```

- [ ] **Step 4: Write the counting helpers `index.ts` needs**

Task 9 completes this file; these two functions are what the billing state read needs now.

`apps/web/src/services/billing/usage.ts`:

```ts
import { and, count, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { billingUsage, emails, type BillingUsage } from "@/db/schema";
import type { UsageWindow } from "./plans";

/**
 * Statuses that consumed a send. Identical to `ACTIVE` in
 * `services/send-limits.ts` on purpose: the meter and the caps must count the
 * same rows, or a customer gets billed for sends a cap refused.
 */
export const BILLABLE = [
  "queued",
  "scheduled",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "complained",
] as const;

/** Emails a team created in `[w.start, w.end)` that count towards usage. */
export async function countSentIn(
  teamId: string,
  w: UsageWindow,
): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(emails)
    .where(
      and(
        eq(emails.teamId, teamId),
        gte(emails.createdAt, w.start),
        lt(emails.createdAt, w.end),
        inArray(emails.status, [...BILLABLE]),
      ),
    );
  return Number(row?.n ?? 0);
}

/** The metering watermark for a team's period, if one has been written. */
export async function usageRow(
  teamId: string,
  periodStart: Date,
): Promise<BillingUsage | undefined> {
  const [row] = await db()
    .select()
    .from(billingUsage)
    .where(
      and(
        eq(billingUsage.teamId, teamId),
        eq(billingUsage.periodStart, periodStart),
      ),
    );
  return row;
}
```

- [ ] **Step 5: Write the failing integration test for event application**

`apps/web/tests/integration/billing-webhook.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";
import { createFakeProvider, type FakeProvider } from "@/services/billing/fake";

let pg: Awaited<ReturnType<typeof startPg>>;
let provider: FakeProvider;
beforeAll(async () => {
  pg = await startPg();
  process.env.BILLING_ENABLED = "1";
  process.env.BILLING_PROVIDER = "fake";
  provider = createFakeProvider();
});
afterAll(async () => {
  await pg.stop();
  delete process.env.BILLING_ENABLED;
  delete process.env.BILLING_PROVIDER;
});

const AUG = new Date("2026-08-01T00:00:00Z");
const SEP = new Date("2026-09-01T00:00:00Z");

describe("handleProviderEvent", () => {
  it("applies subscription.created and resolves the plan from product metadata", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow } = await import("@/services/billing/plans");
    const { team } = await seedTeamWithKey();
    const e = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_a",
      externalCustomerId: team.id,
      productId: "prod_pro",
      status: "active",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
      modifiedAt: AUG,
    });
    expect(
      await handleProviderEvent(provider, e.body, e.headers),
    ).toMatchObject({ status: 200, applied: true });
    const row = (await billingRow(team.id))!;
    expect(row).toMatchObject({
      plan: "pro",
      status: "active",
      includedEmails: 50000,
      overagePer1kCents: 40,
      overageEnabled: true,
      subscriptionId: "sub_a",
      provider: "fake",
    });
    expect(row.periodEnd.toISOString()).toBe(SEP.toISOString());
  });

  it("is idempotent: the same delivery id twice applies once", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { db } = await import("@/db");
    const { billingEvents } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    const e = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_b",
      externalCustomerId: team.id,
      productId: "prod_scale",
      status: "active",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
      deliveryId: "dup_1",
    });
    expect(
      await handleProviderEvent(provider, e.body, e.headers),
    ).toMatchObject({ applied: true });
    expect(
      await handleProviderEvent(provider, e.body, e.headers),
    ).toMatchObject({ status: 200, applied: false, duplicate: true });
    expect(
      await db()
        .select()
        .from(billingEvents)
        .where(eq(billingEvents.id, "dup_1")),
    ).toHaveLength(1);
  });

  it("drops an update whose payload is older than what is stored", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow } = await import("@/services/billing/plans");
    const { team } = await seedTeamWithKey();
    const newer = provider.signSubscriptionEvent("subscription.updated", {
      subscriptionId: "sub_c",
      externalCustomerId: team.id,
      productId: "prod_scale",
      status: "active",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
      modifiedAt: new Date("2026-08-20T00:00:00Z"),
    });
    await handleProviderEvent(provider, newer.body, newer.headers);
    const older = provider.signSubscriptionEvent("subscription.updated", {
      subscriptionId: "sub_c",
      externalCustomerId: team.id,
      productId: "prod_pro",
      status: "past_due",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
      modifiedAt: new Date("2026-08-10T00:00:00Z"),
    });
    expect(
      await handleProviderEvent(provider, older.body, older.headers),
    ).toMatchObject({ status: 200, applied: false, reason: "stale" });
    expect((await billingRow(team.id))!.plan).toBe("scale");
  });

  it("past_due keeps the plan and stamps pastDueAt; revoked ends entitlement", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow, entitlementFrom } =
      await import("@/services/billing/plans");
    const { team } = await seedTeamWithKey();
    const base = {
      subscriptionId: "sub_d",
      externalCustomerId: team.id,
      productId: "prod_pro",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
    };
    const a = provider.signSubscriptionEvent("subscription.created", {
      ...base,
      status: "active",
      modifiedAt: new Date("2026-08-01T00:00:00Z"),
    });
    await handleProviderEvent(provider, a.body, a.headers);
    const b = provider.signSubscriptionEvent("subscription.updated", {
      ...base,
      status: "past_due",
      modifiedAt: new Date("2026-08-05T00:00:00Z"),
    });
    await handleProviderEvent(provider, b.body, b.headers);
    const due = (await billingRow(team.id))!;
    expect(due.status).toBe("past_due");
    expect(due.pastDueAt).not.toBeNull();
    expect(entitlementFrom(due, new Date("2026-08-15T00:00:00Z")).plan).toBe(
      "pro",
    );
    const c = provider.signSubscriptionEvent("subscription.revoked", {
      ...base,
      status: "canceled",
      modifiedAt: new Date("2026-08-09T00:00:00Z"),
    });
    await handleProviderEvent(provider, c.body, c.headers);
    expect(
      entitlementFrom(
        (await billingRow(team.id))!,
        new Date("2026-08-15T00:00:00Z"),
      ),
    ).toMatchObject({ plan: "free", monthlyCap: 3000, managed: true });
  });

  it("records but does not apply an event naming an unknown team", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const e = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_e",
      externalCustomerId: "org_does_not_exist",
      productId: "prod_pro",
      status: "active",
    });
    expect(
      await handleProviderEvent(provider, e.body, e.headers),
    ).toMatchObject({ status: 200, applied: false, reason: "unknown_team" });
  });

  it("rejects a bad signature with 403 and records nothing", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { db } = await import("@/db");
    const { billingEvents } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const e = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_f",
      externalCustomerId: "org_x",
      productId: "prod_pro",
      status: "active",
      deliveryId: "bad_1",
    });
    expect(
      (await handleProviderEvent(provider, `${e.body} `, e.headers)).status,
    ).toBe(403);
    expect(
      await db()
        .select()
        .from(billingEvents)
        .where(eq(billingEvents.id, "bad_1")),
    ).toHaveLength(0);
  });

  it("clears pastDueAt on order.paid", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow } = await import("@/services/billing/plans");
    const { team } = await seedTeamWithKey();
    const a = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_g",
      externalCustomerId: team.id,
      productId: "prod_pro",
      status: "past_due",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
    });
    await handleProviderEvent(provider, a.body, a.headers);
    expect((await billingRow(team.id))!.pastDueAt).not.toBeNull();
    const b = provider.signOrderPaidEvent({
      subscriptionId: "sub_g",
      externalCustomerId: team.id,
    });
    expect(
      await handleProviderEvent(provider, b.body, b.headers),
    ).toMatchObject({ applied: true });
    expect((await billingRow(team.id))!.pastDueAt).toBeNull();
  });

  it("records an unmodelled type as ignored", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { createHmac } = await import("node:crypto");
    const body = JSON.stringify({ type: "benefit.created", data: {} });
    const headers = new Headers({
      "webhook-id": "ign_1",
      "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      "webhook-signature": createHmac("sha256", "fake-billing-secret")
        .update(body)
        .digest("hex"),
    });
    expect(await handleProviderEvent(provider, body, headers)).toMatchObject({
      status: 200,
      applied: false,
      reason: "unmodelled_type",
    });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/billing-webhook.test.ts`
Expected: FAIL — `@/services/billing` does not exist.

- [ ] **Step 7: Write `apps/web/src/services/billing/index.ts`**

```ts
import { eq } from "drizzle-orm";
import {
  FREE_PLAN_METADATA,
  type BillingStateObject,
} from "@sendsprite/shared";
import { db } from "@/db";
import { billingEvents, organization, teamBilling } from "@/db/schema";
import { computeDiff, recordAudit } from "@/lib/audit";
import type { Result } from "@/lib/result";
import { billingConfig } from "./config";
import { createFakeProvider } from "./fake";
import {
  BillingUnavailableError,
  type BillingProvider,
  type ProviderEvent,
  type ProviderSubscription,
} from "./provider";
import { billingRow, entitlementFrom, teamEntitlement } from "./plans";
import { countSentIn, usageRow } from "./usage";

/**
 * The provider for this instance, built once. `fake` is chosen by
 * `BILLING_PROVIDER` (refused in production by the env schema); Polar is
 * loaded lazily so `@polar-sh/sdk` is never pulled in with billing off.
 * Kept on `globalThis` for the same reason `db()` is: Next dev HMR
 * re-evaluates this module and would otherwise build a client per reload.
 */
const g = globalThis as { __sendspriteBilling?: BillingProvider };

export async function getBillingProvider(): Promise<BillingProvider> {
  const cfg = billingConfig();
  if (!cfg.enabled)
    throw new BillingUnavailableError(
      "Billing is not enabled on this instance.",
    );
  if (g.__sendspriteBilling) return g.__sendspriteBilling;
  if (cfg.provider === "fake")
    return (g.__sendspriteBilling = createFakeProvider());
  const { createPolarProvider } = await import("./polar");
  const provider = createPolarProvider({
    accessToken: cfg.accessToken!,
    webhookSecret: cfg.webhookSecret!,
    server: cfg.server,
    eventName: cfg.eventName,
    meterId: cfg.meterId,
  });
  // Warms the lazily-imported SDK so the synchronous `verifyWebhook` is
  // never cold on the first delivery.
  await provider.ready?.();
  return (g.__sendspriteBilling = provider);
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
  const e = await teamEntitlement(teamId, now);
  const [used, usage] = await Promise.all([
    countSentIn(teamId, { start: e.periodStart, end: e.periodEnd }),
    usageRow(teamId, e.periodStart),
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
  };
}

// ------------------------------------------------------------- webhooks

export interface HandleResult {
  status: 200 | 403;
  applied: boolean;
  duplicate?: boolean;
  reason?: string;
}

const teamExists = async (teamId: string): Promise<boolean> =>
  (
    await db()
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
  const inserted = await db()
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
  if (inserted.length === 0)
    return { status: 200, applied: false, duplicate: true };

  const outcome = await apply(provider, event, now);
  await db()
    .update(billingEvents)
    .set({
      appliedAt: outcome.applied ? now : null,
      skippedReason: outcome.applied ? null : (outcome.reason ?? null),
    })
    .where(eq(billingEvents.id, event.deliveryId));
  return { status: 200, ...outcome };
}

async function apply(
  provider: BillingProvider,
  event: ProviderEvent,
  now: Date,
): Promise<{ applied: boolean; reason?: string }> {
  if (event.kind === "ignored")
    return { applied: false, reason: "unmodelled_type" };
  if (event.kind === "order_paid") {
    const teamId = event.externalCustomerId;
    if (!teamId) return { applied: false, reason: "no_external_customer" };
    const updated = await db()
      .update(teamBilling)
      .set({ pastDueAt: null, updatedAt: now })
      .where(eq(teamBilling.teamId, teamId))
      .returning({ teamId: teamBilling.teamId });
    return updated.length
      ? { applied: true }
      : { applied: false, reason: "unknown_team" };
  }
  return applySubscription(provider.id, event.subscription, event.type, now);
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
 * Write the entitlement snapshot for a subscription.
 *
 * Out-of-order safety is one comparison: a payload whose `modifiedAt` is
 * older than what is stored is dropped. Same shape as the status ranking in
 * `services/email-events.ts` — never read-then-write a decision the payload
 * already carries.
 *
 * A product without our metadata resolves to the free plan rather than
 * throwing: an operator adding a bespoke product in the provider dashboard
 * must not be able to 500 the webhook endpoint.
 */
export async function applySubscription(
  providerId: string,
  sub: ProviderSubscription,
  type: string,
  now = new Date(),
): Promise<{ applied: boolean; reason?: string }> {
  const teamId = sub.externalCustomerId;
  if (!teamId) return { applied: false, reason: "no_external_customer" };
  if (!(await teamExists(teamId)))
    return { applied: false, reason: "unknown_team" };

  const before = await billingRow(teamId);
  if (before && sub.modifiedAt.getTime() < before.providerModifiedAt.getTime())
    return { applied: false, reason: "stale" };

  const plan = sub.plan ?? FREE_PLAN_METADATA;
  if (!sub.plan)
    console.warn(
      `[billing] product ${sub.productId} carries no plan metadata; team ${teamId} treated as free`,
    );

  const set = {
    provider: providerId,
    providerCustomerId: sub.customerId,
    subscriptionId: sub.subscriptionId,
    productId: sub.productId,
    plan: plan.plan,
    status: sub.status,
    includedEmails: plan.includedEmails,
    overagePer1kCents: plan.overagePer1kCents,
    overageEnabled: sub.hasMeteredPrice,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    periodStart: sub.currentPeriodStart,
    periodEnd: sub.currentPeriodEnd,
    providerModifiedAt: sub.modifiedAt,
    // Stamped on the transition into past_due, cleared by order.paid.
    pastDueAt: sub.status === "past_due" ? (before?.pastDueAt ?? now) : null,
    // `$onUpdate` does not fire on an upsert.
    updatedAt: now,
  };
  const [after] = await db()
    .insert(teamBilling)
    .values({ teamId, ...set })
    .onConflictDoUpdate({ target: teamBilling.teamId, set })
    .returning();
  if (!after) throw new Error("team_billing upsert returned no row");

  // Audit action convention: `<resource>.<verb>` (Phase 4 opener 8).
  await recordAudit({
    teamId,
    actorUserId: null,
    action: `billing.${type}`,
    targetType: "subscription",
    targetId: sub.subscriptionId,
    diff: computeDiff(auditView(before), auditView(after)),
  });
  return { applied: true };
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

export { entitlementFrom, teamEntitlement };
export type { Entitlement } from "./plans";
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd apps/web && bunx vitest run --project unit tests/unit/billing-plans.test.ts && bunx vitest run --project integration tests/integration/billing-webhook.test.ts`
Expected: PASS (5 unit + 8 integration).

- [ ] **Step 9: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`

```bash
git add apps/web/src/services/billing apps/web/tests
git commit -m "feat(billing): entitlement resolution and idempotent, order-safe webhook application"
```

---

## Task 7: The webhook route

Twenty lines over `handleProviderEvent`, plus the two things a public endpoint needs: a body cap and a 404 when billing is off.

**Files:**

- Create: `apps/web/src/app/api/billing/webhook/route.ts`
- Test: `apps/web/tests/integration/billing-webhook-route.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/tests/integration/billing-webhook-route.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";
import { createFakeProvider } from "@/services/billing/fake";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.BILLING_ENABLED = "1";
  process.env.BILLING_PROVIDER = "fake";
});
afterAll(async () => {
  await pg.stop();
  delete process.env.BILLING_ENABLED;
  delete process.env.BILLING_PROVIDER;
});

const post = (body: string, headers: Headers) =>
  new Request("http://localhost/api/billing/webhook", {
    method: "POST",
    headers,
    body,
  });

describe("POST /api/billing/webhook", () => {
  it("200s a verified delivery and applies it", async () => {
    const { POST } = await import("@/app/api/billing/webhook/route");
    const { billingRow } = await import("@/services/billing/plans");
    // The route builds its own provider; a fake built here signs with the
    // same fixed secret, so the signature verifies across instances.
    const provider = createFakeProvider();
    const { team } = await seedTeamWithKey();
    const e = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_route",
      externalCustomerId: team.id,
      productId: "prod_pro",
      status: "active",
    });
    expect((await POST(post(e.body, e.headers))).status).toBe(200);
    expect((await billingRow(team.id))!.plan).toBe("pro");
  });

  it("403s a bad signature", async () => {
    const { POST } = await import("@/app/api/billing/webhook/route");
    const provider = createFakeProvider();
    const e = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "s",
      externalCustomerId: "org_x",
      productId: "prod_pro",
      status: "active",
    });
    expect((await POST(post(`${e.body} `, e.headers))).status).toBe(403);
  });

  it("413s an oversized body from content-length alone", async () => {
    const { POST } = await import("@/app/api/billing/webhook/route");
    const headers = new Headers({ "content-length": String(200_000) });
    expect((await POST(post("{}", headers))).status).toBe(413);
  });

  it("404s when billing is disabled", async () => {
    const { resetEnvCache } = await import("@/env.schema");
    const { resetBillingProvider } = await import("@/services/billing");
    delete process.env.BILLING_ENABLED;
    resetEnvCache();
    resetBillingProvider();
    const { POST } = await import("@/app/api/billing/webhook/route");
    expect((await POST(post("{}", new Headers()))).status).toBe(404);
    process.env.BILLING_ENABLED = "1";
    resetEnvCache();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/billing-webhook-route.test.ts`
Expected: FAIL — the route module does not exist.

- [ ] **Step 3: Write `apps/web/src/app/api/billing/webhook/route.ts`**

```ts
import { getBillingProvider, handleProviderEvent } from "@/services/billing";
import { billingConfig } from "@/services/billing/config";

export const dynamic = "force-dynamic";

/**
 * Provider webhooks are a few KB. This endpoint is reachable before any
 * signature is checked, so it carries its own cap rather than inheriting the
 * 25 MB one the email routes need (Phase 4 opener 21, closed for this route).
 */
const MAX_BODY_BYTES = 64 * 1024;

const tooLarge = () =>
  Response.json(
    { error: { code: "payload_too_large", message: "Body too large." } },
    { status: 413 },
  );

/**
 * `POST /api/billing/webhook` — the payment provider's endpoint.
 *
 * With `BILLING_ENABLED=false` this is a 404: a self-hosted instance must not
 * expose an endpoint it has no use for. A verified delivery always gets a
 * 200, including one we decide not to apply — a 4xx would make the provider
 * retry something that can never succeed. Dedupe, ordering and persistence
 * all live in `handleProviderEvent`, which is tested directly.
 */
export async function POST(req: Request): Promise<Response> {
  if (!billingConfig().enabled) return new Response(null, { status: 404 });

  // Checked before reading so an oversized body is refused unbuffered. A
  // chunked request has no content-length, hence the second check below.
  if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES)
    return tooLarge();

  // The raw body, not parsed JSON: verification is over the exact bytes and
  // fails on re-serialised JSON.
  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) return tooLarge();

  try {
    const provider = await getBillingProvider();
    const r = await handleProviderEvent(provider, body, req.headers);
    return Response.json(
      { received: r.status === 200, ...(r.reason && { reason: r.reason }) },
      { status: r.status },
    );
  } catch (e) {
    // A 500 makes the provider retry, which is right for a transient fault;
    // the delivery id keeps that retry idempotent.
    console.error("[billing] webhook failed", e);
    return Response.json({ received: false }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/billing-webhook-route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`

```bash
git add apps/web/src/app/api/billing apps/web/tests
git commit -m "feat(billing): signature-verified, idempotent provider webhook endpoint"
```

---

## Task 8: Entitlements — plan caps flow into `send-limits.ts`

No new enforcement mechanism. `checkTeamCaps` gains a resolver in front of it; the error codes, HTTP statuses and OpenAPI document are already correct.

**Files:**

- Modify: `apps/web/src/services/send-limits.ts`, `apps/web/src/lib/api-response.ts`
- Test: `apps/web/tests/integration/billing-entitlements.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/tests/integration/billing-entitlements.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
  delete process.env.BILLING_ENABLED;
  delete process.env.BILLING_PROVIDER;
});

const NOW = new Date("2026-08-15T12:00:00Z");

const enableBilling = async () => {
  process.env.BILLING_ENABLED = "1";
  process.env.BILLING_PROVIDER = "fake";
  (await import("@/env.schema")).resetEnvCache();
};
const disableBilling = async () => {
  delete process.env.BILLING_ENABLED;
  (await import("@/env.schema")).resetEnvCache();
};

/** Insert `n` billable emails created at `at`. */
async function seedEmails(teamId: string, n: number, at = NOW) {
  if (n === 0) return;
  const { db } = await import("@/db");
  const { emails } = await import("@/db/schema");
  const { newId } = await import("@sendsprite/shared");
  await db()
    .insert(emails)
    .values(
      Array.from({ length: n }, () => ({
        id: newId("em"),
        teamId,
        from: "a@b.io",
        fromEmail: "a@b.io",
        to: ["c@d.io"],
        subject: "s",
        status: "sent" as const,
        createdAt: at,
      })),
    );
}

async function seedPlan(
  teamId: string,
  over: Partial<{
    plan: "free" | "pro" | "scale";
    status: string;
    includedEmails: number;
    overageEnabled: boolean;
    periodStart: Date;
    periodEnd: Date;
  }> = {},
) {
  const { db } = await import("@/db");
  const { teamBilling } = await import("@/db/schema");
  const periodStart = over.periodStart ?? new Date("2026-08-10T00:00:00Z");
  await db()
    .insert(teamBilling)
    .values({
      teamId,
      plan: over.plan ?? "pro",
      status: over.status ?? "active",
      includedEmails: over.includedEmails ?? 50000,
      overagePer1kCents: 40,
      overageEnabled: over.overageEnabled ?? true,
      periodStart,
      periodEnd: over.periodEnd ?? new Date("2026-09-10T00:00:00Z"),
      providerModifiedAt: periodStart,
    });
}

describe("plan entitlements feed the existing caps", () => {
  it("billing off: no plan cap, today's behaviour exactly", async () => {
    await disableBilling();
    const { checkTeamCaps, resolveTeamCaps } =
      await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    await seedEmails(team.id, 5);
    expect(await resolveTeamCaps(team.id, NOW)).toMatchObject({
      daily: null,
      monthly: null,
      source: "none",
    });
    expect(await checkTeamCaps(team.id, 1, NOW)).toEqual({ ok: true });
  });

  it("billing on, no subscription: free hard-caps the month at 3 000", async () => {
    await enableBilling();
    const { checkTeamCaps, resolveTeamCaps } =
      await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    const caps = await resolveTeamCaps(team.id, NOW);
    expect(caps).toMatchObject({ monthly: 3000, source: "plan" });
    expect(caps.monthlyFrom.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    await seedEmails(team.id, 3000);
    const r = await checkTeamCaps(team.id, 1, NOW);
    expect(r).toMatchObject({ ok: false, code: "monthly_quota_exceeded" });
    if (r.ok) throw new Error("unreachable");
    expect(r.message).toContain("3,000");
    expect(r.message).toContain("Free");
  });

  it("a paid plan with overage has no monthly cap", async () => {
    await enableBilling();
    const { checkTeamCaps, resolveTeamCaps } =
      await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    await seedPlan(team.id, { overageEnabled: true });
    await seedEmails(team.id, 100);
    expect(await resolveTeamCaps(team.id, NOW)).toMatchObject({
      monthly: null,
      source: "plan",
    });
    expect(await checkTeamCaps(team.id, 1, NOW)).toEqual({ ok: true });
  });

  it("a paid plan without a metered price hard-caps at the include", async () => {
    await enableBilling();
    const { resolveTeamCaps } = await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    await seedPlan(team.id, { overageEnabled: false });
    expect(await resolveTeamCaps(team.id, NOW)).toMatchObject({
      monthly: 50000,
    });
  });

  it("team_settings always wins — the operator escape hatch", async () => {
    await enableBilling();
    const { resolveTeamCaps } = await import("@/services/send-limits");
    const { db } = await import("@/db");
    const { teamSettings } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    await seedPlan(team.id);
    await db()
      .insert(teamSettings)
      .values({ teamId: team.id, dailyLimit: 10, monthlyLimit: 100 });
    expect(await resolveTeamCaps(team.id, NOW)).toMatchObject({
      daily: 10,
      monthly: 100,
      source: "settings",
    });
  });

  it("the billing period, not the calendar month, is the monthly window", async () => {
    await enableBilling();
    const { usageSnapshot } = await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    await seedPlan(team.id, { overageEnabled: false });
    // 20 emails from before the period started must not count against it.
    await seedEmails(team.id, 20, new Date("2026-08-05T00:00:00Z"));
    await seedEmails(team.id, 7, NOW);
    const u = await usageSnapshot(team.id, NOW);
    expect(u.monthlyUsed).toBe(7);
    expect(u.monthlyFrom.toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });

  it("rateHeaders reports the monthly cap when there is no daily one", async () => {
    await enableBilling();
    const { rateHeaders } = await import("@/lib/api-response");
    const { team } = await seedTeamWithKey();
    await seedEmails(team.id, 4);
    const h = await rateHeaders(team.id, NOW);
    expect(h["x-ratelimit-limit"]).toBe("3000");
    expect(h["x-ratelimit-remaining"]).toBe("2996");
    expect(h["x-ratelimit-reset"]).toBe(
      String(Math.floor(Date.UTC(2026, 8, 1) / 1000)),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/billing-entitlements.test.ts`
Expected: FAIL — `resolveTeamCaps` is not exported and `usageSnapshot` has no `monthlyUsed`.

- [ ] **Step 3: Extend `apps/web/src/services/send-limits.ts`**

Add to the existing imports:

```ts
import { lt } from "drizzle-orm";
import { loadEnv } from "@/env.schema";
import { billingRow, entitlementFrom } from "./billing/plans";
```

Add a windowed counter next to `countActiveSince` (keep `countActiveSince` — the daily branch still uses it):

```ts
/** Active-status emails a team created inside `[from, to)`. */
async function countActiveBetween(teamId: string, from: Date, to: Date) {
  const [row] = await db()
    .select({ n: count() })
    .from(emails)
    .where(
      and(
        eq(emails.teamId, teamId),
        gte(emails.createdAt, from),
        lt(emails.createdAt, to),
        inArray(emails.status, [...ACTIVE]),
      ),
    );
  return Number(row?.n ?? 0);
}
```

Add the resolver above `checkTeamCaps`:

```ts
export interface TeamCaps {
  /** Emails per UTC day, or null when unlimited. */
  daily: number | null;
  /** Emails per billing window, or null when unlimited. */
  monthly: number | null;
  /** Start of the window `monthly` is measured over. */
  monthlyFrom: Date;
  /** Exclusive end of that window — what `x-ratelimit-reset` reports. */
  monthlyUntil: Date;
  /** Where the numbers came from, for the refusal message and the UI. */
  source: "settings" | "plan" | "none";
  /** Plan name when a plan supplied a cap; used in the refusal message. */
  planName: string | null;
}

const PLAN_LABEL: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  scale: "Scale",
};

const monthWindow = (now: Date) => ({
  from: startOfMonth(now),
  until: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
});

/**
 * The caps in force for a team, from two sources with a fixed precedence:
 *
 * 1. `team_settings.daily_limit` / `monthly_limit` — the operator's escape
 *    hatch. Set, they win, on a hosted instance as well as a self-hosted one,
 *    column by column (so one team's monthly cap can be lifted without
 *    unsetting its plan).
 * 2. The billing plan, and only when `BILLING_ENABLED` is on. A self-hosted
 *    instance therefore behaves exactly as it did before this phase: no plan,
 *    no cap, this branch never taken.
 *
 * The monthly window is the subscription's billing period, not the calendar
 * month, so a customer who subscribed on the 10th gets their allowance on the
 * 10th. `entitlementFrom` falls back to the calendar month when the stored
 * period has gone stale.
 */
export async function resolveTeamCaps(
  teamId: string,
  now = new Date(),
): Promise<TeamCaps> {
  const [ts] = await db()
    .select({
      daily: teamSettings.dailyLimit,
      monthly: teamSettings.monthlyLimit,
    })
    .from(teamSettings)
    .where(eq(teamSettings.teamId, teamId));
  const month = monthWindow(now);

  if (!loadEnv().BILLING_ENABLED)
    return {
      daily: ts?.daily ?? null,
      monthly: ts?.monthly ?? null,
      monthlyFrom: month.from,
      monthlyUntil: month.until,
      source: ts?.daily != null || ts?.monthly != null ? "settings" : "none",
      planName: null,
    };

  const e = entitlementFrom(await billingRow(teamId), now);
  const settingsWins = ts?.daily != null || ts?.monthly != null;
  return {
    daily: ts?.daily ?? null,
    monthly: ts?.monthly ?? e.monthlyCap,
    monthlyFrom: ts?.monthly != null ? month.from : e.periodStart,
    monthlyUntil: ts?.monthly != null ? month.until : e.periodEnd,
    source: settingsWins ? "settings" : "plan",
    planName: ts?.monthly != null ? null : e.plan,
  };
}
```

Replace the body of `checkTeamCaps` (keep its doc comment's caveats, which are still true, with the window sentence updated):

```ts
/**
 * Per-team daily/monthly caps. UTC calendar day for the daily cap; the
 * billing period (or the UTC month) for the monthly one. Counts by
 * `createdAt` (reservation semantics: an email scheduled for later counts
 * against the window it was created in). Check-then-insert is not atomic, so
 * concurrent creates can overshoot a cap by a few — the caps are soft.
 */
export async function checkTeamCaps(
  teamId: string,
  adding: number,
  now = new Date(),
): Promise<CapResult> {
  const caps = await resolveTeamCaps(teamId, now);
  if (caps.daily == null && caps.monthly == null) return { ok: true };
  if (
    caps.daily != null &&
    (await countActiveSince(teamId, startOfDay(now))) + adding > caps.daily
  )
    return {
      ok: false,
      code: "daily_quota_exceeded",
      message: `Daily limit of ${caps.daily.toLocaleString("en-US")} emails reached.`,
    };
  if (
    caps.monthly != null &&
    (await countActiveBetween(teamId, caps.monthlyFrom, caps.monthlyUntil)) +
      adding >
      caps.monthly
  ) {
    const plan = caps.planName
      ? ` on the ${PLAN_LABEL[caps.planName] ?? caps.planName} plan`
      : "";
    return {
      ok: false,
      code: "monthly_quota_exceeded",
      message: `Monthly limit of ${caps.monthly.toLocaleString("en-US")} emails${plan} reached.`,
    };
  }
  return { ok: true };
}
```

Extend `UsageSnapshot` and `usageSnapshot`:

```ts
export interface UsageSnapshot {
  /** Daily cap, null when unlimited. */
  dailyLimit: number | null;
  /** Emails created today (UTC) that count against the daily cap. */
  dailyUsed: number;
  /** Monthly cap (plan or settings), null when unlimited. */
  monthlyLimit: number | null;
  /** Emails created in the monthly window that count against it. */
  monthlyUsed: number;
  /** Start of that window (billing period or UTC month). */
  monthlyFrom: Date;
  /** Exclusive end of that window. */
  monthlyUntil: Date;
  /** SES Max24HourSend, null when unknown (AWS not connected). */
  instanceQuota: number | null;
  /** Instance-wide sends in the trailing 24 h. */
  instanceUsed: number;
}

/**
 * What the REST rate-limit headers report. The instance-wide count (a scan of
 * every team's sends) is skipped whenever the team has a cap of its own.
 */
export async function usageSnapshot(
  teamId: string,
  now = new Date(),
): Promise<UsageSnapshot> {
  const caps = await resolveTeamCaps(teamId, now);
  const s = await getInstanceSettings();
  const capped = caps.daily != null || caps.monthly != null;
  return {
    dailyLimit: caps.daily,
    dailyUsed:
      caps.daily != null ? await countActiveSince(teamId, startOfDay(now)) : 0,
    monthlyLimit: caps.monthly,
    monthlyUsed:
      caps.monthly != null
        ? await countActiveBetween(teamId, caps.monthlyFrom, caps.monthlyUntil)
        : 0,
    monthlyFrom: caps.monthlyFrom,
    monthlyUntil: caps.monthlyUntil,
    instanceQuota: s.sesDailyQuota ?? null,
    instanceUsed: capped ? 0 : await countSentLast24h(now),
  };
}
```

- [ ] **Step 4: Teach `rateHeaders` about the monthly cap**

Replace the body of `rateHeaders` in `apps/web/src/lib/api-response.ts`:

```ts
/**
 * `x-ratelimit-*` for the emails endpoints: the binding cap is reported. The
 * team daily cap first (reset = next UTC midnight), then the monthly cap
 * (reset = the end of the billing window), then the SES 24-hour quota, which
 * is a trailing window with no fixed reset, so `x-ratelimit-reset` is
 * omitted. No cap at all: `unlimited`, no reset.
 */
export async function rateHeaders(
  teamId: string,
  now = new Date(),
): Promise<Record<string, string>> {
  const u = await usageSnapshot(teamId, now);
  if (u.dailyLimit != null) {
    const reset = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    return {
      "x-ratelimit-limit": String(u.dailyLimit),
      "x-ratelimit-remaining": String(Math.max(0, u.dailyLimit - u.dailyUsed)),
      "x-ratelimit-reset": String(Math.floor(reset / 1000)),
    };
  }
  if (u.monthlyLimit != null)
    return {
      "x-ratelimit-limit": String(u.monthlyLimit),
      "x-ratelimit-remaining": String(
        Math.max(0, u.monthlyLimit - u.monthlyUsed),
      ),
      "x-ratelimit-reset": String(Math.floor(u.monthlyUntil.getTime() / 1000)),
    };
  if (u.instanceQuota != null)
    return {
      "x-ratelimit-limit": String(u.instanceQuota),
      "x-ratelimit-remaining": String(
        Math.max(0, u.instanceQuota - u.instanceUsed),
      ),
    };
  return {
    "x-ratelimit-limit": "unlimited",
    "x-ratelimit-remaining": "unlimited",
  };
}
```

- [ ] **Step 5: Run the whole integration suite**

Run: `cd apps/web && bunx vitest run --project integration`
Expected: PASS, including the pre-existing `tests/integration/send-limits.test.ts` and `rest-emails.test.ts`. Those set `team_settings` limits explicitly and run with billing off, so the `source: "settings"` path must reproduce today's behaviour exactly. If `rest-emails.test.ts` asserts an exact `x-ratelimit-*` triple, confirm it still holds: with billing off and no `team_settings` row, `monthlyLimit` is null and the instance branch is unchanged.

- [ ] **Step 6: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`

```bash
git add apps/web/src/services/send-limits.ts apps/web/src/lib/api-response.ts apps/web/tests
git commit -m "feat(billing): plan entitlements resolve into the existing team caps"
```

---

## Task 9: Usage metering — hourly rollups and the sweep job

The design in one sentence: **one event per team per closed UTC hour, with `externalId = "<teamId>:<bucketStart ISO>"`**, so the provider's own deduplication turns our at-least-once delivery into exactly-once and a failed ingest simply leaves the watermark where it was.

Why not one event per email: at Scale volume that is 300 000 API calls a month per customer. Why not a cumulative counter: a delta computed from a watermark cannot be retried safely — if the call succeeded but the response was lost, the next run sends a _different, larger_ delta and double-bills. Bucketed events are the only shape where "send it again" is free.

**Files:**

- Modify: `apps/web/src/services/billing/usage.ts` (completing Task 6's stub), `apps/web/src/jobs/queues.ts`, `apps/web/src/jobs/handlers/index.ts`
- Create: `apps/web/src/jobs/handlers/billing-meter.ts`
- Test: `apps/web/tests/unit/billing-usage-buckets.test.ts`, `apps/web/tests/integration/billing-rollup.test.ts`

- [ ] **Step 1: Write the failing unit test for the bucket maths**

`apps/web/tests/unit/billing-usage-buckets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MAX_BUCKETS_PER_RUN,
  SETTLE_MS,
  floorHour,
  hourlyBuckets,
  usageExternalId,
} from "@/services/billing/usage";

const iso = (s: string) => new Date(s);

describe("floorHour", () => {
  it("truncates to the UTC hour", () => {
    expect(floorHour(iso("2026-08-25T09:41:37.412Z")).toISOString()).toBe(
      "2026-08-25T09:00:00.000Z",
    );
    expect(floorHour(iso("2026-08-25T09:00:00.000Z")).toISOString()).toBe(
      "2026-08-25T09:00:00.000Z",
    );
  });
});

describe("hourlyBuckets", () => {
  const now = iso("2026-08-25T10:07:00Z");

  it("returns every closed hour from `from` up to the settle horizon", () => {
    // now - 30 min = 09:37, so the last reportable bucket ends at 09:00.
    const b = hourlyBuckets(iso("2026-08-25T07:00:00Z"), now);
    expect(b.map((x) => x.start.toISOString())).toEqual([
      "2026-08-25T07:00:00.000Z",
      "2026-08-25T08:00:00.000Z",
    ]);
    expect(b.at(-1)!.end.toISOString()).toBe("2026-08-25T09:00:00.000Z");
  });

  it("aligns a `from` that is mid-hour down to the hour", () => {
    // A billing period starting at 07:32 is metered from the 07:00 bucket;
    // that bucket's externalId is the same one the previous period already
    // ingested, so the provider deduplicates the overlap for us.
    expect(
      hourlyBuckets(iso("2026-08-25T07:32:00Z"), now)[0]!.start.toISOString(),
    ).toBe("2026-08-25T07:00:00.000Z");
  });

  it("is empty when nothing has settled yet", () => {
    expect(hourlyBuckets(iso("2026-08-25T10:00:00Z"), now)).toEqual([]);
    expect(hourlyBuckets(iso("2026-08-25T09:00:00Z"), now)).toEqual([]);
  });

  it("caps a long catch-up so one run cannot blow up", () => {
    const b = hourlyBuckets(iso("2026-01-01T00:00:00Z"), now);
    expect(b).toHaveLength(MAX_BUCKETS_PER_RUN);
    expect(b[0]!.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("the settle window is 30 minutes", () => {
    expect(SETTLE_MS).toBe(30 * 60 * 1000);
  });
});

describe("usageExternalId", () => {
  it("is deterministic per team and bucket", () => {
    expect(usageExternalId("org_1", iso("2026-08-25T09:00:00Z"))).toBe(
      "org_1:2026-08-25T09:00:00.000Z",
    );
    expect(usageExternalId("org_1", iso("2026-08-25T09:00:00Z"))).toBe(
      usageExternalId("org_1", iso("2026-08-25T09:00:00.000Z")),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project unit tests/unit/billing-usage-buckets.test.ts`
Expected: FAIL — `hourlyBuckets` and friends are not exported.

- [ ] **Step 3: Complete `apps/web/src/services/billing/usage.ts`**

Append to the file created in Task 6 (keep `BILLABLE`, `countSentIn` and `usageRow` as they are):

```ts
import { sql } from "drizzle-orm";
import { teamBilling } from "@/db/schema";
import type { BillingProvider, UsageEvent } from "./provider";
import { entitlementFrom } from "./plans";

const HOUR_MS = 3600 * 1000;

/**
 * How long after an hour closes before it is reported. Sends resolve within
 * minutes, so half an hour is generous; the point is that a bucket is counted
 * once, after its rows have stopped moving between statuses.
 */
export const SETTLE_MS = 30 * 60 * 1000;

/** Most buckets one team gets in one run, so a long outage catches up over several. */
export const MAX_BUCKETS_PER_RUN = 168; // one week

/** Truncate to the UTC hour. */
export const floorHour = (d: Date): Date =>
  new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);

/**
 * Deterministic id for one team's bucket. The provider deduplicates on it,
 * which is what makes re-sending after a failed or timed-out ingest free —
 * and what makes the overlap at a billing-period boundary harmless.
 */
export const usageExternalId = (teamId: string, bucketStart: Date): string =>
  `${teamId}:${bucketStart.toISOString()}`;

/**
 * Closed, UTC-hour-aligned buckets from `from` (floored to the hour) up to
 * the settle horizon, capped at `MAX_BUCKETS_PER_RUN`.
 *
 * Alignment is global, not relative to a billing period: an email belongs to
 * exactly one bucket for all time, so a period boundary can only re-emit a
 * bucket that already has an id the provider has seen.
 */
export function hourlyBuckets(
  from: Date,
  now: Date,
): { start: Date; end: Date }[] {
  const horizon = floorHour(new Date(now.getTime() - SETTLE_MS));
  const out: { start: Date; end: Date }[] = [];
  for (
    let t = floorHour(from).getTime();
    t < horizon.getTime() && out.length < MAX_BUCKETS_PER_RUN;
    t += HOUR_MS
  )
    out.push({ start: new Date(t), end: new Date(t + HOUR_MS) });
  return out;
}

/**
 * Billable emails per UTC hour for one team over `[from, to)`.
 *
 * The bucket key comes back as epoch seconds, not a timestamp: `date_trunc`
 * over `at time zone 'UTC'` yields a `timestamp without time zone`, which the
 * driver would parse in the *process's* local zone — correct in a UTC
 * container, wrong on a developer's machine. Epoch seconds have no zone.
 */
export async function countByHour(
  teamId: string,
  from: Date,
  to: Date,
): Promise<Map<number, number>> {
  const rows = (await db().execute(sql`
    select
      extract(epoch from date_trunc('hour', ${emails.createdAt} at time zone 'UTC'))::bigint as bucket_epoch,
      count(*)::int as n
    from ${emails}
    where ${emails.teamId} = ${teamId}
      and ${emails.createdAt} >= ${from.toISOString()}::timestamptz
      and ${emails.createdAt} < ${to.toISOString()}::timestamptz
      and ${emails.status} in ${sql.raw(`(${BILLABLE.map((s) => `'${s}'`).join(",")})`)}
    group by 1
  `)) as unknown as { bucket_epoch: string | number; n: number }[];
  const out = new Map<number, number>();
  for (const r of rows) out.set(Number(r.bucket_epoch) * 1000, Number(r.n));
  return out;
}

/** One team's pending usage: the events to send and the watermark they reach. */
export interface TeamRollup {
  teamId: string;
  periodStart: Date;
  periodEnd: Date;
  events: UsageEvent[];
  /** Exclusive end of the last bucket in `events` (or of the settled range). */
  through: Date;
  units: number;
}

/**
 * Build (do not send) the pending rollup for one team.
 *
 * Buckets with no sends produce no event but still advance the watermark:
 * there is nothing to meter and re-scanning an empty hour forever would be
 * pointless work.
 */
export async function planTeamRollup(
  teamId: string,
  periodStart: Date,
  periodEnd: Date,
  eventName: string,
  now: Date,
): Promise<TeamRollup | null> {
  const row = await usageRow(teamId, periodStart);
  const from = row?.reportedThrough ?? floorHour(periodStart);
  const buckets = hourlyBuckets(from, now);
  if (buckets.length === 0) return null;
  const counts = await countByHour(
    teamId,
    buckets[0]!.start,
    buckets.at(-1)!.end,
  );
  const events: UsageEvent[] = [];
  let units = 0;
  for (const b of buckets) {
    const n = counts.get(b.start.getTime()) ?? 0;
    if (n === 0) continue;
    units += n;
    events.push({
      externalId: usageExternalId(teamId, b.start),
      externalCustomerId: teamId,
      name: eventName,
      count: n,
      timestamp: b.start,
    });
  }
  return {
    teamId,
    periodStart,
    periodEnd,
    events,
    through: buckets.at(-1)!.end,
    units,
  };
}

/** Move a team's watermark forward. Only ever called after a 2xx ingest. */
export async function commitRollup(r: TeamRollup, now: Date): Promise<void> {
  const set = {
    periodEnd: r.periodEnd,
    reportedThrough: r.through,
    reportedUnits: sql`${billingUsage.reportedUnits} + ${r.units}`,
    // `$onUpdate` does not fire on an upsert.
    updatedAt: now,
  };
  await db()
    .insert(billingUsage)
    .values({
      teamId: r.teamId,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      reportedThrough: r.through,
      reportedUnits: r.units,
    })
    .onConflictDoUpdate({
      target: [billingUsage.teamId, billingUsage.periodStart],
      set,
    });
}

/** Events per ingest call. A team's whole run fits in one chunk by construction. */
const CHUNK_EVENTS = 500;

export interface RollupSummary {
  teams: number;
  events: number;
  units: number;
  failed: number;
}

/**
 * Meter every team that has a provider customer, in one pass.
 *
 * Teams are packed whole into chunks — one team's buckets are capped at 168,
 * far under the chunk size, so a team never straddles two calls. A chunk that
 * fails leaves the watermarks of every team in it untouched: the next run
 * rebuilds exactly the same buckets with exactly the same `externalId`s, and
 * the provider deduplicates whatever did land.
 *
 * **The provider being down must never affect sending.** This runs only on
 * the cron, never on the send path, and it swallows every provider error.
 */
export async function rollupUsage(
  provider: BillingProvider,
  eventName: string,
  now = new Date(),
): Promise<RollupSummary> {
  const teams = await db()
    .select()
    .from(teamBilling)
    .where(sql`${teamBilling.providerCustomerId} is not null`);

  const pending: TeamRollup[] = [];
  for (const t of teams) {
    const e = entitlementFrom(t, now);
    const r = await planTeamRollup(
      t.teamId,
      e.periodStart,
      e.periodEnd,
      eventName,
      now,
    );
    if (r) pending.push(r);
  }

  const summary: RollupSummary = {
    teams: pending.length,
    events: 0,
    units: 0,
    failed: 0,
  };
  let chunk: TeamRollup[] = [];
  let chunkSize = 0;

  const flush = async () => {
    if (chunk.length === 0) return;
    const events = chunk.flatMap((r) => r.events);
    try {
      if (events.length > 0) await provider.ingestUsage(events);
      for (const r of chunk) await commitRollup(r, now);
      summary.events += events.length;
      summary.units += chunk.reduce((n, r) => n + r.units, 0);
    } catch (e) {
      // Watermarks stay put; the next tick re-sends the same externalIds.
      summary.failed += chunk.length;
      console.error(
        `[billing] usage ingest failed for ${chunk.length} team(s); will retry next tick:`,
        (e as Error).message,
      );
    }
    chunk = [];
    chunkSize = 0;
  };

  for (const r of pending) {
    if (chunkSize + r.events.length > CHUNK_EVENTS) await flush();
    chunk.push(r);
    chunkSize += r.events.length;
  }
  await flush();
  return summary;
}
```

> Two imports to fold into the file's existing import block rather than duplicating: `sql` joins the `drizzle-orm` import, and `teamBilling` joins the `@/db/schema` import. `db` and `emails` are already imported.

- [ ] **Step 4: Write the failing integration test**

`apps/web/tests/integration/billing-rollup.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";
import { createFakeProvider, type FakeProvider } from "@/services/billing/fake";

let pg: Awaited<ReturnType<typeof startPg>>;
let provider: FakeProvider;
beforeAll(async () => {
  pg = await startPg();
  process.env.BILLING_ENABLED = "1";
  process.env.BILLING_PROVIDER = "fake";
  provider = createFakeProvider();
});
afterAll(async () => {
  await pg.stop();
  delete process.env.BILLING_ENABLED;
  delete process.env.BILLING_PROVIDER;
});

const PERIOD_START = new Date("2026-08-25T00:00:00Z");
const PERIOD_END = new Date("2026-09-25T00:00:00Z");
/** 10:07 — the 08:00 and 09:00 buckets have settled, 10:00 has not closed. */
const NOW = new Date("2026-08-25T10:07:00Z");

async function seedTeam() {
  const { db } = await import("@/db");
  const { teamBilling } = await import("@/db/schema");
  const { team } = await seedTeamWithKey();
  await db()
    .insert(teamBilling)
    .values({
      teamId: team.id,
      provider: "fake",
      providerCustomerId: `cus_${team.id}`,
      subscriptionId: `sub_${team.id}`,
      plan: "pro",
      status: "active",
      includedEmails: 50000,
      overagePer1kCents: 40,
      overageEnabled: true,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      providerModifiedAt: PERIOD_START,
    });
  return team;
}

async function seedEmails(teamId: string, at: Date, n: number) {
  const { db } = await import("@/db");
  const { emails } = await import("@/db/schema");
  const { newId } = await import("@sendsprite/shared");
  await db()
    .insert(emails)
    .values(
      Array.from({ length: n }, () => ({
        id: newId("em"),
        teamId,
        from: "a@b.io",
        fromEmail: "a@b.io",
        to: ["c@d.io"],
        subject: "s",
        status: "sent" as const,
        createdAt: at,
      })),
    );
}

describe("rollupUsage", () => {
  it("emits one event per non-empty settled hour and advances the watermark", async () => {
    const { rollupUsage, usageRow } = await import("@/services/billing/usage");
    const team = await seedTeam();
    await seedEmails(team.id, new Date("2026-08-25T08:10:00Z"), 3);
    await seedEmails(team.id, new Date("2026-08-25T08:50:00Z"), 2);
    await seedEmails(team.id, new Date("2026-08-25T09:30:00Z"), 4);
    // Not settled yet: the 10:00 hour has not closed.
    await seedEmails(team.id, new Date("2026-08-25T10:01:00Z"), 9);

    const s = await rollupUsage(provider, "email.sent", NOW);
    expect(s).toMatchObject({ events: 2, units: 9, failed: 0 });
    expect(provider.ingestedIds).toEqual(
      expect.arrayContaining([
        `${team.id}:2026-08-25T08:00:00.000Z`,
        `${team.id}:2026-08-25T09:00:00.000Z`,
      ]),
    );
    expect(provider.ingested.get(team.id)).toBe(9);
    const row = (await usageRow(team.id, PERIOD_START))!;
    expect(row.reportedThrough!.toISOString()).toBe("2026-08-25T10:00:00.000Z");
    expect(row.reportedUnits).toBe(9);
  });

  it("is a no-op on the second run — nothing new has settled", async () => {
    const { rollupUsage } = await import("@/services/billing/usage");
    const before = provider.ingestedIds.length;
    expect(await rollupUsage(provider, "email.sent", NOW)).toMatchObject({
      events: 0,
    });
    expect(provider.ingestedIds).toHaveLength(before);
  });

  it("a provider outage advances nothing, and the retry does not double-count", async () => {
    const { rollupUsage, usageRow } = await import("@/services/billing/usage");
    const team = await seedTeam();
    await seedEmails(team.id, new Date("2026-08-25T08:15:00Z"), 5);

    provider.failNext("provider is down");
    const failed = await rollupUsage(provider, "email.sent", NOW);
    expect(failed.failed).toBeGreaterThan(0);
    expect(await usageRow(team.id, PERIOD_START)).toBeUndefined();
    expect(provider.ingested.get(team.id)).toBeUndefined();

    const ok = await rollupUsage(provider, "email.sent", NOW);
    expect(ok.failed).toBe(0);
    expect(provider.ingested.get(team.id)).toBe(5);
    expect((await usageRow(team.id, PERIOD_START))!.reportedUnits).toBe(5);
  });

  it("re-sending a bucket after a lost response does not double-bill", async () => {
    // Simulates the dangerous case: the provider stored the events but we
    // never saw the 2xx, so the watermark did not move and the same buckets
    // are sent again. The deterministic externalId makes the second send a
    // duplicate rather than a second charge.
    const { planTeamRollup } = await import("@/services/billing/usage");
    const team = await seedTeam();
    await seedEmails(team.id, new Date("2026-08-25T08:20:00Z"), 6);
    const r = (await planTeamRollup(
      team.id,
      PERIOD_START,
      PERIOD_END,
      "email.sent",
      NOW,
    ))!;
    expect(await provider.ingestUsage(r.events)).toMatchObject({ inserted: 1 });
    expect(await provider.ingestUsage(r.events)).toMatchObject({
      inserted: 0,
      duplicates: 1,
    });
    expect(provider.ingested.get(team.id)).toBe(6);
  });

  it("ignores teams that never went through checkout", async () => {
    const { rollupUsage } = await import("@/services/billing/usage");
    const { team } = await seedTeamWithKey();
    await seedEmails(team.id, new Date("2026-08-25T08:00:00Z"), 100);
    await rollupUsage(provider, "email.sent", NOW);
    expect(provider.ingested.get(team.id)).toBeUndefined();
  });

  it("counts only billable statuses", async () => {
    const { planTeamRollup } = await import("@/services/billing/usage");
    const { db } = await import("@/db");
    const { emails } = await import("@/db/schema");
    const { newId } = await import("@sendsprite/shared");
    const team = await seedTeam();
    const at = new Date("2026-08-25T08:00:00Z");
    await seedEmails(team.id, at, 2);
    for (const status of ["failed", "cancelled"] as const)
      await db()
        .insert(emails)
        .values({
          id: newId("em"),
          teamId: team.id,
          from: "a@b.io",
          fromEmail: "a@b.io",
          to: ["c@d.io"],
          subject: "s",
          status,
          createdAt: at,
        });
    const r = (await planTeamRollup(
      team.id,
      PERIOD_START,
      PERIOD_END,
      "email.sent",
      NOW,
    ))!;
    expect(r.units).toBe(2);
  });
});
```

> Check the exact `cancelled`/`canceled` spelling in `EMAIL_STATUS` (`packages/shared/src/api/emails.ts`) before running — use whichever the enum defines.

- [ ] **Step 5: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/billing-rollup.test.ts`
Expected: FAIL — `rollupUsage` / `planTeamRollup` are not exported.

- [ ] **Step 6: Run it to verify it passes**

Run: `cd apps/web && bunx vitest run --project unit tests/unit/billing-usage-buckets.test.ts && bunx vitest run --project integration tests/integration/billing-rollup.test.ts`
Expected: PASS (7 unit + 6 integration).

- [ ] **Step 7: Register the cron job**

`apps/web/src/jobs/queues.ts` — add one entry to `Q`:

```ts
  billingMeterSweep: "billing.meter-sweep",
```

`apps/web/src/jobs/handlers/billing-meter.ts`:

```ts
import { registerQueue } from "../boss";
import { Q } from "../queues";
import { getBillingProvider } from "@/services/billing";
import { billingConfig } from "@/services/billing/config";
import { rollupUsage } from "@/services/billing/usage";

/**
 * Cron: meter every subscribed team's settled hours to the payment provider.
 *
 * Runs at :07 so the previous hour has closed and passed the 30-minute settle
 * window before it is reported. Exported so tests can drive it directly.
 *
 * Failures are swallowed by `rollupUsage`: a provider outage must never fail
 * the job (and, more to the point, never touch the send path). Watermarks
 * simply do not advance and the next tick re-sends the same buckets, which
 * the provider deduplicates on their `externalId`.
 */
export async function runBillingMeterSweep(now = new Date()) {
  const cfg = billingConfig();
  if (!cfg.enabled) return { teams: 0, events: 0, units: 0, failed: 0 };
  const provider = await getBillingProvider();
  const s = await rollupUsage(provider, cfg.eventName, now);
  console.info(
    `[billing] metered ${s.units} emails in ${s.events} events for ${s.teams} team(s); ${s.failed} deferred`,
  );
  return s;
}

// Registered only when billing is on: a self-hosted instance gets no billing
// queue and no hourly tick. Handler modules are imported from `startWorker()`
// and `getBoss()`, both at runtime, so reading the env here is safe.
if (billingConfig().enabled)
  registerQueue(Q.billingMeterSweep, () => runBillingMeterSweep(), {
    cron: "7 * * * *",
    // retryLimit 0: a failed run is simply retried by the next tick, and the
    // rollup is idempotent, so there is nothing a pg-boss retry would add.
    queue: { retryLimit: 0 },
  });
```

`apps/web/src/jobs/handlers/index.ts` — add the import at the end:

```ts
import "./billing-meter";
```

- [ ] **Step 8: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`

```bash
git add apps/web/src/services/billing apps/web/src/jobs apps/web/tests
git commit -m "feat(billing): hourly usage rollups ingested with deterministic event ids"
```

---

## Task 10: Checkout and portal — permission, actions

Mutations go through the same thin-action → service path as everything else, and gain a role check so a `member` can see the plan but not change it.

**Files:**

- Modify: `packages/shared/src/roles.ts`
- Create: `apps/web/src/app/app/settings/billing/actions.ts`
- Test: `packages/shared/tests/roles.test.ts` (extend, or create if absent), `apps/web/tests/integration/billing-actions.test.ts`

- [ ] **Step 1: Write the failing role test**

Add to `packages/shared/tests/roles.test.ts` (create the file with this content if there is none):

```ts
import { describe, expect, it } from "vitest";
import { ACTIONS, can } from "../src/index";

describe("billing.manage", () => {
  it("is a known action", () => {
    expect(ACTIONS).toContain("billing.manage");
  });
  it("is owner and admin only — a member can look but not buy", () => {
    expect(can("owner", "billing.manage")).toBe(true);
    expect(can("admin", "billing.manage")).toBe(true);
    expect(can("member", "billing.manage")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && bunx vitest run tests/roles.test.ts`
Expected: FAIL — `"billing.manage"` is not in `ACTIONS`.

- [ ] **Step 3: Add the action**

In `packages/shared/src/roles.ts`, add `"billing.manage"` to the `ACTIONS` tuple (after `"settings.manage"`), and to the `ADMIN` array (which `OWNER` spreads). Do not add it to `MEMBER`.

- [ ] **Step 4: Write the failing action test**

`apps/web/tests/integration/billing-actions.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_URL = "https://mail.example.com";
  process.env.BILLING_ENABLED = "1";
  process.env.BILLING_PROVIDER = "fake";
  (await import("@/env.schema")).resetEnvCache();
});
afterAll(async () => {
  await pg.stop();
  delete process.env.BILLING_ENABLED;
  delete process.env.BILLING_PROVIDER;
});

describe("startCheckout / openPortal", () => {
  it("returns a checkout URL for a known plan", async () => {
    const { startCheckout } = await import("@/services/billing");
    const { team } = await seedTeamWithKey();
    const r = await startCheckout(
      { teamId: team.id, userId: "u_1", email: "a@b.io" },
      "pro",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.url).toContain("prod_pro");
    expect(r.data.url).toContain(encodeURIComponent(team.id));
  });

  it("writes a billing.checkout audit row", async () => {
    const { startCheckout } = await import("@/services/billing");
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    await startCheckout({ teamId: team.id, userId: "u_1" }, "scale");
    const rows = await db()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.teamId, team.id),
          eq(auditLog.action, "billing.checkout"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe("scale");
  });

  it("refuses an unknown plan", async () => {
    const { startCheckout } = await import("@/services/billing");
    const { team } = await seedTeamWithKey();
    expect(
      await startCheckout({ teamId: team.id, userId: "u_1" }, "enterprise"),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("refuses the portal for a team that never subscribed", async () => {
    const { openPortal } = await import("@/services/billing");
    const { team } = await seedTeamWithKey();
    expect(await openPortal({ teamId: team.id, userId: "u_1" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("returns a portal URL once a subscription exists", async () => {
    const { openPortal } = await import("@/services/billing");
    const { db } = await import("@/db");
    const { teamBilling } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    await db()
      .insert(teamBilling)
      .values({
        teamId: team.id,
        provider: "fake",
        providerCustomerId: "cus_1",
        subscriptionId: "sub_1",
        plan: "pro",
        status: "active",
        includedEmails: 50000,
        overagePer1kCents: 40,
        overageEnabled: true,
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
        providerModifiedAt: new Date("2026-08-01T00:00:00Z"),
      });
    const r = await openPortal({ teamId: team.id, userId: "u_1" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.url).toContain(encodeURIComponent(team.id));
  });

  it("both refuse when billing is off", async () => {
    const { resetEnvCache } = await import("@/env.schema");
    const { openPortal, startCheckout } = await import("@/services/billing");
    delete process.env.BILLING_ENABLED;
    resetEnvCache();
    const { team } = await seedTeamWithKey();
    expect(
      await startCheckout({ teamId: team.id, userId: "u_1" }, "pro"),
    ).toMatchObject({ ok: false, code: "not_configured" });
    expect(await openPortal({ teamId: team.id, userId: "u_1" })).toMatchObject({
      ok: false,
      code: "not_configured",
    });
    process.env.BILLING_ENABLED = "1";
    resetEnvCache();
  });
});
```

- [ ] **Step 5: Run it to verify it fails or passes**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/billing-actions.test.ts`
Expected: PASS — `startCheckout` and `openPortal` shipped in Task 6. If anything fails here it is a Task 6 defect; fix it in `services/billing/index.ts`, not by weakening the test.

- [ ] **Step 6: Write `apps/web/src/app/app/settings/billing/actions.ts`**

```ts
"use server";
import { revalidatePath } from "next/cache";
import { can } from "@sendsprite/shared";
import type { Result } from "@/lib/result";
import { requireTeam } from "@/lib/session";
import * as billing from "@/services/billing";

export type { Result } from "@/lib/result";

const DENIED: Result<never> = {
  ok: false,
  error: "You don't have permission to do that.",
  code: "forbidden",
};

/** Server actions are thin: resolve the actor, check the role, delegate. */
async function actor() {
  const ctx = await requireTeam();
  return {
    teamId: ctx.team.id,
    userId: ctx.userId,
    email: ctx.session.user.email,
    role: ctx.role,
  };
}

/**
 * A checkout URL for `plan`. The client navigates to it; a redirect from the
 * action would lose the typed refusal, and the provider's checkout page lives
 * on another origin.
 */
export async function checkout(plan: string): Promise<Result<{ url: string }>> {
  const a = await actor();
  if (!can(a.role, "billing.manage")) return DENIED;
  const res = await billing.startCheckout(a, plan);
  if (res.ok) revalidatePath("/app/settings/billing");
  return res;
}

/** A customer-portal URL for the team's existing subscription. */
export async function portal(): Promise<Result<{ url: string }>> {
  const a = await actor();
  if (!can(a.role, "billing.manage")) return DENIED;
  return billing.openPortal(a);
}
```

- [ ] **Step 7: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`

```bash
git add packages/shared apps/web/src/app/app/settings/billing apps/web/tests
git commit -m "feat(billing): billing.manage permission, checkout and portal actions"
```

---

## Task 11: The billing page

One page under Settings, in the app's existing visual language: `num-stamp` eyebrows, `metric-xl` for the one number that matters, `Card` panels, `Badge` for status, inline `role="alert"` errors. No modal, no toast, no new primitive.

**Files:**

- Create: `apps/web/src/app/app/settings/billing/page.tsx`, `apps/web/src/app/app/settings/billing/BillingPanel.tsx`
- Modify: `apps/web/src/app/app/settings/page.tsx`
- Test: covered by the e2e in Task 12

- [ ] **Step 1: Write `apps/web/src/app/app/settings/billing/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { can } from "@sendsprite/shared";
import { requireTeam } from "@/lib/session";
import { planCatalog, teamBillingState } from "@/services/billing";
import { billingConfig } from "@/services/billing/config";
import { BillingPanel } from "./BillingPanel";

export const metadata = { title: "Billing" };

export default async function BillingPage() {
  // With billing off the page does not exist — a self-hoster must not find a
  // half-working purchase flow by typing the URL.
  if (!billingConfig().enabled) notFound();
  const ctx = await requireTeam();
  const [state, catalog] = await Promise.all([
    teamBillingState(ctx.team.id),
    planCatalog(),
  ]);
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <BillingPanel
        state={state}
        catalog={catalog.map((p) => ({
          plan: p.plan,
          name: p.name,
          priceCents: p.priceCents,
          includedEmails: p.includedEmails,
          overagePer1kCents: p.overagePer1kCents,
        }))}
        canManage={can(ctx.role, "billing.manage")}
      />
    </div>
  );
}
```

- [ ] **Step 2: Write `apps/web/src/app/app/settings/billing/BillingPanel.tsx`**

```tsx
"use client";
import { useState, useTransition } from "react";
import type { BillingStateObject } from "@sendsprite/shared";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { checkout, portal } from "./actions";
import type { Result } from "./actions";

export interface CatalogEntry {
  plan: string;
  name: string;
  priceCents: number;
  includedEmails: number;
  overagePer1kCents: number;
}

const n = (v: number) => v.toLocaleString("en-US");
const money = (cents: number) =>
  cents === 0 ? "Free" : `$${(cents / 100).toLocaleString("en-US")}`;
const day = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));

/** Amber over 80 %, red at or over the limit; grey while there is no limit. */
function barTone(used: number, limit: number | null) {
  if (limit === null) return "bg-indigo-400";
  const r = used / limit;
  return r >= 1 ? "bg-danger" : r >= 0.8 ? "bg-warning" : "bg-indigo-400";
}

export function BillingPanel({
  state,
  catalog,
  canManage,
}: {
  state: BillingStateObject;
  catalog: CatalogEntry[];
  canManage: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // The provider's checkout and portal live on another origin, so the action
  // returns a URL and the browser navigates; a server-side redirect would
  // throw the typed refusal away.
  const go = (fn: () => Promise<Result<{ url: string }>>) =>
    start(async () => {
      setError(null);
      try {
        const res = await fn();
        if (res.ok) window.location.href = res.data.url;
        else setError(res.error);
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });

  const limit = state.overageEnabled ? null : state.includedEmails;
  const pct =
    limit === null
      ? Math.min(100, (state.used / Math.max(1, state.includedEmails)) * 100)
      : Math.min(100, (state.used / Math.max(1, limit)) * 100);
  const current = catalog.find((c) => c.plan === state.plan);

  return (
    <>
      {state.status === "past_due" && (
        <p
          role="alert"
          className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200"
        >
          <strong>Payment failed.</strong> Your plan is still active while we
          retry the charge. Update your payment method in the billing portal to
          avoid losing it.
        </p>
      )}
      {state.cancelAtPeriodEnd && (
        <p
          role="alert"
          className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200"
        >
          Your subscription ends on {day(state.periodEnd)}. After that this team
          returns to the Free plan.
        </p>
      )}

      <Card className="flex flex-col gap-4">
        <CardHeader>
          <CardTitle>Current plan</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={state.plan === "free" ? "muted" : "indigo"}>
              {current?.name ?? state.plan}
            </Badge>
            {state.status && state.status !== "active" && (
              <Badge
                variant={state.status === "past_due" ? "warning" : "muted"}
              >
                {state.status.replace(/_/g, " ")}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="num-stamp">
              Emails this period · {day(state.periodStart)} –{" "}
              {day(state.periodEnd)}
            </p>
            <p className="metric-xl">{n(state.used)}</p>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
              role="progressbar"
              aria-valuenow={state.used}
              aria-valuemin={0}
              aria-valuemax={limit ?? state.includedEmails}
              aria-label="Emails used this period"
            >
              <div
                className={`h-full ${barTone(state.used, limit)}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-sm text-white/65">
              {n(state.includedEmails)} included
              {state.overageEnabled
                ? ` · then ${money(state.overagePer1kCents)} per 1,000`
                : " · hard limit on this plan"}
              {state.reportedUnits > 0 &&
                ` · ${n(state.reportedUnits)} reported for billing`}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            {state.managed && (
              <Button
                variant="secondary"
                disabled={!canManage || pending}
                onClick={() => go(() => portal())}
              >
                {pending ? "Opening…" : "Manage billing"}
              </Button>
            )}
          </div>
          {error && <Alert>{error}</Alert>}
          {!canManage && (
            <p className="text-sm text-white/50">
              Only owners and admins can change the plan.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plans</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-4 sm:grid-cols-3">
          {catalog.map((p) => {
            const isCurrent = p.plan === state.plan;
            return (
              <div
                key={p.plan}
                className={`flex flex-col gap-2 rounded-md border p-4 ${
                  isCurrent ? "border-indigo-500/60" : "border-white/10"
                }`}
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
                  {p.overagePer1kCents > 0 &&
                    `, then ${money(p.overagePer1kCents)} / 1,000`}
                </p>
                {isCurrent ? (
                  <p className="text-sm text-indigo-300">Current plan</p>
                ) : (
                  <Button
                    disabled={!canManage || pending}
                    onClick={() => go(() => checkout(p.plan))}
                  >
                    {p.plan === "free" ? "Downgrade" : "Choose"}
                  </Button>
                )}
              </div>
            );
          })}
          {catalog.length === 0 && (
            <p className="text-sm text-white/50 sm:col-span-3">
              The plan catalog is unavailable right now. Try again in a moment.
            </p>
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
```

- [ ] **Step 3: Link it from Settings**

In `apps/web/src/app/app/settings/page.tsx`, import the config and add a card above the existing owner-only Instance card. Mirroring that card's shape is deliberate: there is no settings sub-nav to extend, and inventing one for a single page would be a bigger change than the page itself.

```tsx
import { billingConfig } from "@/services/billing/config";
```

```tsx
{
  billingConfig().enabled && (
    <Card>
      <CardHeader>
        <CardTitle>Billing</CardTitle>
      </CardHeader>
      <CardBody>
        <p className="text-sm text-white/70">
          Your plan, this period&apos;s usage, and payment details.{" "}
          <Link href="/app/settings/billing">Open billing</Link>
        </p>
      </CardBody>
    </Card>
  );
}
```

- [ ] **Step 4: Check it renders**

Run: `cd apps/web && bun run build`
Expected: a clean build. `/app/settings/billing` must not be statically prerendered — `requireTeam()` reads headers, so it is dynamic already; confirm the build output does not list it as a static route.

- [ ] **Step 5: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`

```bash
git add apps/web/src/app/app/settings
git commit -m "feat(web): billing page — plan, period usage, upgrade and portal"
```

---

## Task 12: e2e, docs, README, status

**Files:**

- Create: `apps/web/tests/e2e/billing.spec.ts`, `apps/web/src/app/docs/billing/page.mdx`
- Modify: `apps/web/playwright.config.ts`, `apps/web/src/app/docs/nav.ts`, `README.md`, this plan file

- [ ] **Step 1: Turn billing on for the e2e suite**

In `apps/web/playwright.config.ts`, add to the `webServer.env` block, next to `AWS_E2E_MOCK`:

```ts
          // Billing against the in-memory provider: the e2e proves the page,
          // the flag and the entitlement wiring without a Polar account.
          BILLING_ENABLED: "1",
          BILLING_PROVIDER: "fake",
```

- [ ] **Step 2: Write the e2e spec**

`apps/web/tests/e2e/billing.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("billing page shows the Free plan, this period's usage and the catalog", async ({
  page,
}) => {
  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  await page.getByRole("link", { name: /open billing/i }).click();
  await expect(page).toHaveURL(/\/app\/settings\/billing$/);

  // Current plan card.
  await expect(page.getByText("Sendsprite Free")).toBeVisible();
  await expect(page.getByText(/3,000 included/)).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: /emails used this period/i }),
  ).toBeVisible();

  // Catalog: three tiers, Free marked current, the paid ones actionable.
  await expect(page.getByText("Sendsprite Pro")).toBeVisible();
  await expect(page.getByText("Sendsprite Scale")).toBeVisible();
  await expect(page.getByText("$12")).toBeVisible();
  await expect(page.getByText("Current plan")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose" }).first(),
  ).toBeEnabled();

  // A team that has never subscribed has nothing to manage.
  await expect(
    page.getByRole("button", { name: /manage billing/i }),
  ).toHaveCount(0);
});

test("checkout sends the browser to the provider", async ({ page }) => {
  await page.goto("/app/settings/billing");
  // The fake provider's checkout URL is off-origin and does not resolve;
  // asserting the navigation attempt is what matters, not the destination.
  const [request] = await Promise.all([
    page.waitForRequest(/fake\.billing\.test\/checkout\/prod_pro/, {
      timeout: 15_000,
    }),
    page
      .getByText("Sendsprite Pro")
      .locator("xpath=ancestor::div[1]")
      .getByRole("button", { name: "Choose" })
      .click(),
  ]);
  expect(request.url()).toContain("prod_pro");
});
```

> If asserting an off-origin navigation proves flaky, replace the second test with a `page.route("**/fake.billing.test/**", (r) => r.fulfill({ status: 200, body: "ok" }))` intercept before the click and assert on the intercepted URL. Do not delete the test — the checkout button doing nothing is exactly the regression this catches.

- [ ] **Step 3: Run the e2e**

Run: `cd apps/web && bun run test:e2e`
Expected: PASS, and every pre-existing spec still green. `landing.spec.ts`, `docs.spec.ts`, `send.spec.ts` and `sdk.spec.ts` now run with billing on and no subscription, i.e. a 3 000/month free cap — well above anything they send, so none of them should change. If `send.spec.ts` fails on a quota, that is a real bug in the entitlement wiring, not a test to relax.

- [ ] **Step 4: Write the docs page**

`apps/web/src/app/docs/billing/page.mdx`:

```mdx
export const metadata = {
  title: "Billing",
  description:
    "Plans, included volume, overage, usage metering and the customer portal on the hosted Sendsprite service.",
};

# Billing

Billing applies to the **hosted service at sendsprite.com only**. A
self-hosted instance runs with `BILLING_ENABLED=false` (the default): there is
no Billing page, no checkout, no provider webhook endpoint, and no plan-derived
limits. Everything on this page is about the hosted service.

## What you are paying for

Sendsprite sends through **your own Amazon SES account** — the one you connect
in **Dashboard → Settings → Instance**. AWS bills you for delivery at its own
rates, directly, and Sendsprite never marks that up. The plans below pay for
the control plane: the API, the dashboard, domain provisioning, the event
pipeline, webhooks, the SMTP relay and the MCP server.

## Plans

| Plan  | Price  | Included emails / month | Overage       |
| ----- | ------ | ----------------------- | ------------- |
| Free  | $0     | 3,000                   | —             |
| Pro   | $12/mo | 50,000                  | $0.40 / 1,000 |
| Scale | $49/mo | 300,000                 | $0.25 / 1,000 |

"Emails" means messages accepted by the Sendsprite API, the SMTP relay or the
dashboard. A message refused before it is queued — an unverified domain, a
suppressed recipient, a validation error — is never counted. A message that
later bounces **is** counted: it was sent.

Recipients do not multiply the count: one API call with ten `to` addresses is
one email.

## Included volume, overage and limits

On **Free**, the included volume is a hard limit. Past it the API answers
`429 monthly_quota_exceeded` until the next month.

On **Pro** and **Scale**, sending past the included volume is billed at the
overage rate rather than blocked — losing your sending because you had a good
week is the wrong failure. Every response carries the usual headers:
```

x-ratelimit-limit: 50000
x-ratelimit-remaining: 48211
x-ratelimit-reset: 1789084800

```

`x-ratelimit-reset` is the end of your billing period as a Unix timestamp.

## Your billing period

Your period runs from the day you subscribed, not from the 1st: subscribe on
the 10th and your allowance renews on the 10th. **Dashboard → Settings →
Billing** shows the current period's dates and how much of it you have used.

Free teams have no subscription, so their window is the UTC calendar month.

## How usage is measured

Usage is rolled up **hourly**: once an hour has closed and settled, Sendsprite
sends one usage record for it to the payment provider. Nothing is sent per
email, so a slow or unavailable provider can never slow down or fail a send —
the worst case is that the usage figure on your invoice catches up a little
later. Each record carries a deterministic id, so a retried delivery is
discarded by the provider instead of being billed twice.

The number on your billing page is read live from your email log, so it is
always current; the "reported for billing" figure next to it is how much has
reached the provider so far.

## Upgrading, downgrading and payment methods

**Dashboard → Settings → Billing**:

- **Choose** on a plan opens a checkout for it. Upgrades take effect as soon as
  the payment clears.
- **Manage billing** opens the customer portal: payment methods, invoices,
  receipts, and cancellation.

Owners and admins can change the plan; members can see it.

Cancelling keeps your plan until the end of the period you have paid for; after
that the team returns to Free, and the Free limit applies again.

If a payment fails, your plan stays active while the provider retries the
charge and the dashboard shows a banner. Update your card in the portal.

## Payments and invoicing

Payments are processed by **Polar**, acting as merchant of record: Polar is the
seller on your invoice and handles VAT and sales tax. Invoices and receipts
live in the customer portal.

Your Sendsprite **team id** is the customer reference passed to Polar, so it
appears on the customer record there. Note that team ids carry no prefix, unlike
every other public Sendsprite id (`em_`, `dom_`, `key_`, `wh_`) — they come
from the authentication provider.

## Self-hosting

Nothing here applies. `BILLING_ENABLED` defaults to `false`, and with it off:

- no Billing page, and no Billing card under Settings;
- `POST /api/billing/webhook` returns 404;
- no billing job is registered with the worker;
- the only send limits are the ones you set yourself
  (`team_settings.daily_limit` / `monthly_limit`) and your SES account's own
  quota.

Even on the hosted service, `team_settings` wins over the plan wherever it is
set — it is the operator's escape hatch, per team and per column.
```

Register it in `apps/web/src/app/docs/nav.ts`, after "Webhooks" and before "SDK":

```ts
  { title: "Billing", href: "/docs/billing" },
```

- [ ] **Step 5: README**

Three edits:

1. Under **"Suppressions, limits, errors, retention"**, extend the **Limits** bullet's parenthetical to mention the third source:

   > …plus optional per-team daily and monthly caps (`team_settings.daily_limit` / `monthly_limit`, unset by default) and, on an instance with `BILLING_ENABLED=1`, the subscription plan's included volume (measured over the billing period, not the calendar month; `team_settings` always wins where it is set).

2. In the **Environment reference** table, add five rows after `LANDING_ENABLED`:

   | Variable               | Default      | Notes                                                                                       |
   | ---------------------- | ------------ | ------------------------------------------------------------------------------------------- |
   | `BILLING_ENABLED`      | `false`      | Hosted-service billing. Off: no Billing page, no checkout, no webhook route, no plan limits |
   | `POLAR_ACCESS_TOKEN`   | —            | Polar organization token; required when billing is on                                       |
   | `POLAR_WEBHOOK_SECRET` | —            | Polar webhook signing secret; required when billing is on                                   |
   | `POLAR_SERVER`         | `production` | `sandbox` while developing                                                                  |
   | `POLAR_METER_ID`       | —            | Optional, display only: shows Polar's own meter balance on the billing page                 |

   and a sentence under the table:

   > Billing is a hosted-service feature and is off by default; a self-hosted
   > instance never loads the payment SDK. Plans are read from the provider's
   > product metadata (`plan`, `included_emails`, `overage_per_1k_cents`), so
   > prices change in the Polar dashboard without a deploy — no product id is
   > compiled in.

3. **Roadmap** — replace the last two sentences with:

   > Phase 5: billing — plans, usage metering, entitlements — done. Phase 6
   > (next): templates, preview, contacts, campaigns, audit UI.

- [ ] **Step 6: Run the full gate**

Run: `bun run typecheck && bun run lint && bun run format:check && bun run test && bun run test:integration && bun run test:e2e`
Expected: all green. Record the counts for the status block.

- [ ] **Step 7: Append the status block to this plan, commit and tag**

Append a `## Phase 5 status: COMPLETE` section to this file in the shape Phase 4 used: what shipped per task with commit hashes, the test counts, notes on anything that deviated, and a **Phase 6 openers** list seeded with:

**Carried forward unchanged from the Phase 4 openers:** 1–4 (templates, contacts, CLI `templates pull|push`, MCP template/contact tools — the body of Phase 6), 5–7 (audit log UI; audit rows for cancel/resend/reschedule; REST audit ip/UA), 9 (`sending_only` and `GET /emails`), 10 (per-key stream connection cap), 12–16 (MCP host allowlist, MCP stdout hazard, `workspace:*` publish, CLI column padding, CLI password prompt), 17–25 (Phase 3 carry-overs), 22–30 (operational). Opener 8 (audit naming) and 21 (body caps) are partly closed — see the "openers" section at the top of this plan.

**New, created by this phase:**

1. **A production Polar organization does not exist yet.** Everything is in sandbox (`01ab540b-e2bd-4386-9849-2190aca34b2e`). Creating the production org, re-creating the three products with the same `metadata` keys, and re-creating the `emails` meter is a manual checklist that must happen before the first customer.
2. **Confirm the meter's aggregation.** Our events carry `metadata.count`, so the meter must aggregate **`sum` over `metadata.count`**, not `count()` of events. A meter counting events would report 24 units a day per team no matter the volume. Verify in the Polar dashboard before taking money.
3. **The webhook needs a public URL.** Polar cannot deliver to a laptop. The first true end-to-end run depends on Phase 4 opener 26 (push and deploy) or a tunnel. Until then the fake provider is the only coverage.
4. **Webhook secret rotation is undocumented.** `POLAR_WEBHOOK_SECRET` is a single value; rotating it means a window where one of the two secrets fails. Either accept a brief window during a maintenance minute or accept a list of secrets.
5. **No email is sent on a payment failure.** The dashboard shows a banner and nothing else. Transactional mail from the instance to its own users is still blocked on the instance having a verified sending domain of its own (deferred since Phase 3).
6. **Downgrades are the provider's semantics, not ours.** "Downgrade" opens a checkout for the cheaper product; whether Polar prorates, schedules it for the period end, or charges immediately is Polar's behaviour and has not been exercised. Test it in sandbox before advertising it.
7. **Refunds and disputes are not modelled.** `refund.created` and `order.refunded` verify and are recorded as ignored. Deciding whether a refund should claw back entitlement is a policy question, not a bug.
8. **Team ids remain unprefixed** (Phase 4 opener 11) and are now the provider's customer reference. Decide before the first production customer, because changing them afterwards orphans every Polar customer mapping.
9. **`billing_events` grows without bound.** The nightly `retention.purge` does not touch it. A row is a few hundred bytes and the volume is tiny, but it should join the retention sweep eventually.
10. **No admin view of billing.** There is no instance-level list of subscriptions or failed webhook deliveries; diagnosis is `select * from billing_events where skipped_reason is not null`.

```bash
git add -A
git commit -m "test(e2e): billing page against the fake provider; docs, README and Phase 5 status"
git tag phase-5-complete
```

---

## Self-review

**Spec coverage (the eight scoped items):**

1. **Schema** — `team_billing` (subscription/plan state), `billing_usage` (per team per period counters and metering watermark), `billing_events` (delivery-id primary key, which is what makes webhook handling idempotent) → Task 2. Drizzle conventions followed; `precision: 3` applied to `billing_events.created_at` (the one table shaped for future keyset paging) and deliberately not to the other two, with the reason written down. ✔
2. **Provider-agnostic interface + Polar implementation** — `BillingProvider` (Task 4) with checkout, portal, catalog, webhook verification and usage ingest; `@polar-sh/sdk` ^0.49.0 (version checked on npm) behind a lazy import (Task 5); an in-memory fake implementing the same interface, which is what proves the seam. ✔
3. **Webhook route** — `subscription.created/updated/active/canceled/uncanceled/revoked/past_due`, `order.paid`, and payment failure via `past_due`; idempotent (PK on delivery id), signature-verified, and out-of-order-safe (`providerModifiedAt` guard) → Tasks 6–7. ✔
4. **Usage metering** — `{ name, external_customer_id, metadata: { count } }` per closed hour, not per email; ~720 calls/team/month at any volume; the failure path is explicit and tested (`failNext`), the send path never calls the provider → Task 9. ✔
5. **Entitlements** — extend `send-limits.ts` rather than inventing a parallel mechanism: `resolveTeamCaps` in front of the existing `checkTeamCaps`, the existing `daily_quota_exceeded`/`monthly_quota_exceeded` codes, `usageSnapshot`/`rateHeaders` extended → Task 8. ✔
6. **Billing UI** — plan, usage against quota for the period, upgrade/downgrade via checkout, manage via portal, in the existing visual language (`Card`, `num-stamp`, `metric-xl`, `Badge`, inline `role="alert"`) → Tasks 10–11. ✔
7. **`BILLING_ENABLED` plumbing and off-behaviour** — Task 3 for the env, and off-behaviour is asserted in three places: `resolveTeamCaps` (Task 8 test 1), the webhook route 404 (Task 7 test 4), and the page `notFound()` (Task 11). No cron is registered and no SDK is loaded. ✔
8. **Tests and docs** — unit (5 files), integration with embedded Postgres (5 files), e2e (1 spec, provider faked); `/docs/billing` + nav entry + README env rows, limits bullet and roadmap → Task 12. ✔

**The two open externals** are handled by design, not by a TODO: the meter id is optional configuration used only for a display line, and overage is driven by a boolean read off the subscription payload, so fixed-tier billing works today and metered overage attaches the moment Polar has it — no code change either way. ✔

**Placeholder scan:** every code step carries complete code. Three places defer to the codebase rather than guessing, each naming exactly what to check and bounding the blast radius: the SDK page-iterator shape in Task 5 (two `for await` loops, tests unaffected), the `cancelled`/`canceled` spelling in `EMAIL_STATUS` in Task 9, and the `BASE` constant's name in the existing `tests/unit/env.test.ts` in Task 3. Task 6's `usage.ts` is explicitly a partial file completed by Task 9, and both tasks say so.

**Type consistency:** `PlanMetadata` (`plan`, `includedEmails`, `overagePer1kCents`) is one shape from `planFromProductMetadata` through `PlanProduct`, `ProviderSubscription.plan`, `team_billing` and `Entitlement`. `UsageWindow { start, end }` is used by `countSentIn`, `calendarMonth` and `hourlyBuckets`; `TeamCaps` uses `monthlyFrom`/`monthlyUntil` in `resolveTeamCaps`, `checkTeamCaps`, `usageSnapshot` and `rateHeaders` alike. `Result<T>` is the return of every service function, `ProviderEvent.deliveryId` is the idempotency key in the provider, the service and the table, and `BillingProvider` is the only type the route, the job and the actions know.

**Two decisions worth confirming before implementation starts** (both are recorded above as chosen, and both are cheap to reverse in Task 8 / Task 6 respectively): that `past_due` keeps the paid entitlement rather than dropping to Free after a grace window, and that a paid plan with metered overage has **no** hard ceiling at all — no "you may spend at most $X" guard. The second is the one with real financial exposure, in both directions.
