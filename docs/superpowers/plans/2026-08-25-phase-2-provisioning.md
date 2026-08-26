# Sendsprite Phase 2 — Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner can connect AWS (instance role, one-click CloudFormation, or pasted keys) and Cloudflare from the browser, request SES production access, and add sending domains that Sendsprite provisions in SES and Cloudflare DNS and verifies automatically.

**Architecture:** All cloud calls live in `src/lib/aws/*` and `src/lib/cloudflare/*` (thin, injectable clients) and are orchestrated by `src/services/*` (no `next/*` imports, unit/integration-testable). Long-running work (provision, verify, account refresh) runs as pg-boss jobs registered through `registerQueue`. Credentials come from `instance_settings` (encrypted) or the SDK default chain when `aws_mode = instance_role`. The one-click path is a CloudFormation quick-create link to a template published on S3; a Lambda custom resource POSTs the created keys back to a one-time callback URL. Phase 2 also lands the "openers" the Phase 1 final review asked for.

**Tech Stack:** `@aws-sdk/client-sesv2`, `@aws-sdk/client-sns`, `@aws-sdk/client-sts` (3.1117), `aws-sdk-client-mock` 4.1 (tests), `sns-validator` 0.3.5, Node `dns/promises`, Cloudflare API v4 via `fetch`, pg-boss queues, Drizzle migrations `0003`+.

**Spec:** `docs/superpowers/specs/2026-08-24-sendsprite-design.md` §6 (provisioning), §5 (`domains`, `instance_settings`), §12 (errors). Phase 1 plan: `docs/superpowers/plans/2026-08-24-phase-1-foundation.md` ("Rules learned in review" and "Phase 1 status" apply).

**Decisions made while planning (deviations/clarifications):**

- **Quick-create requires an S3 `templateURL`** (AWS docs: only S3 URL formats are accepted). The template is published by CI to `s3://sendsprite-cfn/v<version>/sendsprite-connect.yaml` (public-read). The instance builds the link from `CFN_TEMPLATE_URL` (default `https://sendsprite-cfn.s3.us-east-1.amazonaws.com/latest/sendsprite-connect.yaml`). Creating that bucket is a one-time maintainer step (documented in Task 17). Self-hosters who don't trust it can set `CFN_TEMPLATE_URL` to their own copy or use the manual path.
- `PutAccountDetails` requires `MailType` (`TRANSACTIONAL|MARKETING`) and `WebsiteURL`; `UseCaseDescription` is deprecated but still accepted — we send it. `ContactLanguage` `EN`.
- REST `/api/v1/domains` is deferred to Phase 3 (it needs API keys). Phase 2 ships the dashboard + services; Phase 3 wraps them.
- Phase 2 SNS endpoint only confirms the subscription and acknowledges notifications; Phase 3 processes events.
- Domain verification is a per-domain `domain.verify` job (exclusive policy, keyed on the domain id) driven by a 2-minute `domain.verify-sweep` cron that enqueues every pending, provisioned domain whose last check is ≥ 100 s old; a domain leaves the set once verified or failed (72 h window). _Originally the job re-enqueued itself with `startAfter`; the integration review found that pg-boss's exclusive index drops a self-send while the job is still `active`, so the loop died after one iteration (see "Integration review fixes")._

---

## Phase 2 status: COMPLETE (2026-08-25, HEAD after `06eed28` + docs commit + integration review fixes)

Tasks 1–17 shipped; every task's "Review follow-ups" block above records what changed after review. Docs (`README.md`, `infra/aws/README.md`, spec §6/§7) describe the shipped behaviour, not the original plan text. Open these as the **first tasks of the Phase 3 plan** (extension points, not Phase 2 defects):

1. **Verified-domain re-check.** `domain.verify` stops once a domain is `verified`; nothing notices records removed later. Add a periodic re-check (daily cron over `verified` rows, or SES `DKIM`/`MAIL FROM` status from the SNS feed) that flips the domain back to `pending` and warns.
2. **Heartbeat persistence for `WORKER_MODE=separate`** (Phase 1 opener #6, still open): the web container cannot report worker health without a heartbeat row; Phase 3 has real queues to drive it.
3. **Reconciliation cron for stale `pending` domains** — a domain whose `domain.provision` job was lost (worker restart before the singleton verify loop was scheduled) stays `pending` with no job (the status enum is `pending|verified|failed`; an empty `dkim_tokens` is the only sign provisioning never ran). A cron that finds `pending` rows with no active job and re-enqueues, and expires rows past `verify_until`, closes the gap.
4. **Connect-warning persistence from the callback path.** `POST /api/setup/aws/callback` only logs `warning` (for example SNS subscribe failed) and returns it to the Lambda; the wizard never sees it. Persist it (on the token or `instance_settings`) so `/api/setup/aws/status` can surface it.
5. **Retention job consuming `retentionDays`.** `instance_settings.retention_days` is stored by the Instance tab (T15) but nothing reads it yet; the Phase 3 email tables need the purge job.
6. **SNS notification ingestion.** `POST /api/webhooks/ses` verifies signatures and confirms subscriptions but only `console.info`s `Notification` messages; Phase 3 replaces that branch with `ses.ingest` (events, bounces/complaints → suppressions). Signature verification against recorded real SNS payloads is also still owed (T9 tests cover only the guardrails).
7. **REST `/api/v1/domains`** wrapping `services/domains.ts` once API keys exist (spec §7).
8. **`queue: { policy }` guard.** `registerQueue`'s `QueueOptions.policy` is create-time only in pg-boss 12: changing it for an existing queue is silently ignored. Either assert the stored policy on start (`getQueue(name).policy`) and fail loudly, or document that a policy change needs `deleteQueue` + recreate.
9. **E2E ordering dependency.** `playwright.config.ts` has a `setup` project that `app` depends on, because the smoke spec needs a completed wizard. New specs must go in `app` (or a new project with the same dependency); a spec that runs before `setup` on a fresh database is redirected to `/setup`.

### Integration review fixes (after the Phase 2 docs commit)

Blocking findings from the Phase 2 integration review, fixed in three commits. The Task 13 code blocks below were re-synced from the files.

**C1 — verify loop died after one iteration.** `domain.verify` is `policy: "exclusive"` and `verifyDomain` re-enqueued itself with `singletonKey: domainId` while its own job was still `active`; pg-boss's `job_i6` unique index (`state <= 'active'`) turned that insert into `ON CONFLICT DO NOTHING`, so no second check ever ran. Replaced by a sweeper: `domain.verify-sweep` (`Q.domainVerifySweep`, cron `*/2 * * * *`, `retryLimit: 0`, in `jobs/handlers/domain-verify.ts`, exported as `sweepDomainVerification()`) calls `selectSweepCandidates()` (`services/domains.ts`: `status = 'pending' AND dkim_tokens != '[]' AND (last_checked_at IS NULL OR last_checked_at < now() - 100 s)`) and sends one keyed `domain.verify` per row. Exclusive dedup now works because the sweep never runs inside an active verify job. Expired rows are included on purpose (simpler than a second query): `verifyDomain` already marks a row past `verify_until` as `failed`, which removes it from the set. `verifyDomain`/`reverifyDomain` no longer take `enqueue`; `provisionDomain` keeps its initial `startAfter: 30` send. Every `verifyDomain` outcome (including "AWS is not connected") bumps `lastCheckedAt`, so a disconnected instance costs one cheap attempt per tick per pending domain. This closes the verify half of opener #3 above (a lost provision job is still only visible as empty `dkim_tokens`; "Retry provisioning" below is the manual recovery). `tests/integration/domain-loop.test.ts` runs the loop through a real pg-boss worker: create → provision job → first verify → two sweep-driven verifies, asserting `lastCheckedAt` advances each time.

**C2 — queues did not exist in the web process.** With `WORKER_MODE=separate`/`none` the web process never called `createQueue`, so `enqueue("domain.provision")` from the server action threw. `getBoss()` now imports `./handlers` (registration side effects only) after `start()` and runs `ensureQueue()` (createQueue + updateQueue, shared with `attach`) for every registration, without `work()`. Non-worker processes construct `new PgBoss({ supervise: false, schedule: false })` (pg-boss `MaintenanceOptions.supervise` / `SchedulingOptions.schedule`; only the worker supervises and schedules); `startWorker()` replaces a send-only instance with a supervising one. `createDomain` wraps the enqueue in try/catch: on failure the row is kept with `lastError: "Could not queue provisioning: <msg>"` and `ok:true` is returned; `retryProvisioning(actor, id, { enqueue })` (audit `domains.retry_provisioning`, refused once tokens exist) plus a "Retry provisioning" button in `DomainActions` (shown when `dkimTokens.length === 0 && lastError`) re-sends the job. Terminal provisioning failure (I3): `domain.provision` is registered with `includeMetadata: true` (new `registerQueue` option → `JobWithMetadata` handler), and on the attempt where `job.retryCount >= job.retryLimit` (pg-boss bumps `retry_count` on every re-fetch) the handler passes `{ finalAttempt: true }` so `provisionDomain` also sets `status: "failed"`; Re-verify stays disabled for such rows and "Retry provisioning" is the way out.

**One-click policy, webhook fallback, timeouts (commit 2).** The one-click IAM policy lacked `sns:ConfirmSubscription`, so the SDK confirm the webhook prefers failed under one-click and the route returned 500 without ever trying SubscribeURL. `infra/aws/sendsprite-connect.yaml` now grants `sns:ConfirmSubscription` and `sns:SetTopicAttributes` in the `sendsprite-*`-scoped statement (cfn-lint clean; the inline Python still `ast.parse`s), and `POST /api/webhooks/ses` wraps the `ConfirmSubscriptionCommand` path in try/catch: any SDK error is logged and the host-guarded `fetch(SubscribeURL, { redirect: "error", signal })` path runs instead (`ses-webhook.test.ts`: `AuthorizationError` → fetch used, 200). Timeout alignment: the Lambda's POST timeout is 45 s (function `Timeout: 60`), and `verifyIdentity`'s propagation retry budget is capped at 5 attempts × 3 s (≤ 15 s) so the whole connect fits; `aws-connect.test.ts` expects 5 STS calls. `infra/aws/README.md` and the README list the new permissions.

**Domain exits and connect safety (commit 3).** I6: `deleteDomain` with `awsMode === "none"` skips SES and Cloudflare, deletes the row, audits, and reports every record that has a `cloudflareId` as `leftoverDnsRecords` (nothing can be cleaned up in an account we no longer reach). I7: `reverifyDomain` no longer demotes a verified domain up front; it resets the window, sends a `failed` row back to `pending`, and runs `verifyDomain(id, deps, { force: true })`, which re-checks a verified domain and keeps `verifiedAt` while SES still reports SUCCESS, demoting to `pending` (verifiedAt null) only when it does not. I5: `connectWithKeys`/`detectInstanceRole` return `{ ok:false, code:"ALREADY_CONNECTED" }` when `awsMode !== "none"` (no AWS call, no state change); `POST /api/setup/aws/callback` maps that to 409 after consuming the token and recording the failure reason. I9: `provisionDomain` persists tokens + `expectedRecords` before the Cloudflare loop, upserts sequentially and re-persists after each id lands, so a mid-loop failure leaves the created ids on the row (delete removes them; the retry's upsert-by-name reuses them). I13: `playwright.config.ts` sets `reuseExistingServer: false` so a stray dev server with another env can never be picked up.

---

**Additional Phase 3 openers from the final integration re-verification (2026-08-25):** distinct audit action names per instance mutation (+ a dedicated row for `PutAccountDetails`); ship `src/worker.ts` in the image or drop `WORKER_MODE=separate`; use `domains.region` for domain ops (region drift on reconnect); persist the SNS-subscribe warning so the wizard can show it; atomic token reissue (partial unique index on `issued_by WHERE consumed_at IS NULL`); SNS `Timestamp` freshness check; pin `cfn-lint` in CI; a Phase 3 test that fires the `domain.verify-sweep` cron itself. Tenancy decisions are recorded in the spec (§6, before §7).

## File structure (Phase 2 additions)

```
apps/web/
├─ src/env.schema.ts                       + CFN_TEMPLATE_URL, AWS_DEFAULT_REGION
├─ src/db/schema/
│  ├─ instance.ts                          + sns_subscription_arn, ses_review_status, aws_account_id, cloudflare_account_name
│  ├─ team-settings.ts                     team_settings (opener #3)
│  ├─ setup-tokens.ts                      one-time tokens for the CFN callback
│  ├─ domains.ts                           domains
│  └─ index.ts                             re-exports
├─ drizzle/0003_*.sql … 0005_*.sql
├─ src/lib/audit.ts                        + RequestMeta (ip, userAgent) helper
├─ src/lib/auth.ts                         + organizationHooks → audit (opener #1); session hook ordering (opener #5)
├─ src/lib/aws/
│  ├─ credentials.ts                       resolveAwsCredentials(): keys | instance role
│  ├─ clients.ts                           sesv2()/sns()/sts() factories (injectable for tests)
│  ├─ quick-create.ts                      buildQuickCreateUrl() (pure)
│  └─ ses-account.ts                       mapAccount() (pure) — GetAccount → status/quota
├─ src/lib/cloudflare/client.ts            CloudflareClient (fetch-injectable)
├─ src/lib/dns/
│  ├─ records.ts                           expectedRecords() (pure)
│  ├─ zone-match.ts                        matchZone() (pure)
│  └─ check.ts                             checkRecords() with injectable resolver
├─ src/lib/sns-message.ts                  verifySnsMessage() wrapper around sns-validator
├─ src/services/
│  ├─ instance-settings.ts                 + self-audit (opener #1)
│  ├─ setup-tokens.ts                      issue/consume
│  ├─ aws-connect.ts                       detectInstanceRole, connectWithKeys, ensureSesInfrastructure, refreshSesAccount, requestProductionAccess, disconnectAws
│  ├─ cloudflare-connect.ts                connectCloudflare, disconnectCloudflare, listZones
│  └─ domains.ts                           createDomain, provisionDomain, verifyDomain, deleteDomain, listDomains
├─ src/jobs/handlers/
│  ├─ index.ts                             + imports below
│  ├─ ses-refresh-account.ts               cron hourly
│  ├─ domain-provision.ts
│  └─ domain-verify.ts
├─ src/jobs/boss.ts                        registerQueue opts.queue (opener #2)
├─ src/app/api/setup/aws/callback/route.ts POST from Lambda
├─ src/app/api/setup/aws/status/route.ts   GET polled by wizard
├─ src/app/api/webhooks/ses/route.ts       SNS endpoint (confirm + ack)
├─ src/app/setup/                          wizard: page.tsx, actions.ts, steps/*.tsx
├─ src/app/app/settings/instance/          owner-only instance tab (reuses wizard step components)
├─ src/app/app/domains/                    page.tsx, new/page.tsx, [id]/page.tsx, actions.ts, components
├─ src/app/app/layout.tsx                  redirect owner to /setup until setupCompleted
├─ src/app/app/page.tsx                    checklist reads real domain state
└─ tests/
   ├─ unit/{quick-create,ses-account,dns-records,zone-match,dns-check,sns-message}.test.ts
   └─ integration/{aws-connect,cloudflare-connect,domains,setup-callback,ses-webhook,audit-hooks}.test.ts
infra/aws/sendsprite-connect.yaml          CloudFormation template
.github/workflows/ci.yml                   + cfn-lint job; + publish template on tag (commented until bucket exists)
```

---

### Task 1: Openers — queue options, session ordering, test harness retry

**Files:**

- Modify: `apps/web/src/jobs/boss.ts`, `apps/web/src/lib/auth.ts`, `apps/web/tests/integration/_pg.ts`
- Test: `apps/web/tests/integration/worker.test.ts` (add one case)

- [x] **Step 1: Failing test — queue options are applied**

Append to `apps/web/tests/integration/worker.test.ts` inside the existing `describe` (after the worker is running):

```ts
it("registerQueue passes queue options to pg-boss", async () => {
  const { registerQueue, getBoss } = await import("@/jobs/boss");
  registerQueue("test.opts", async () => {}, {
    queue: {
      retryLimit: 7,
      retryDelay: 3,
      retryBackoff: true,
      expireInSeconds: 120,
    },
  });
  const boss = await getBoss();
  // attach is fire-and-forget after start; wait for the queue to exist
  let q = await boss.getQueue("test.opts");
  for (let i = 0; !q && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    q = await boss.getQueue("test.opts");
  }
  expect(q).toMatchObject({
    retryLimit: 7,
    retryDelay: 3,
    retryBackoff: true,
    expireInSeconds: 120,
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `cd apps/web && bun run test:integration -- worker`
Expected: FAIL — `retryLimit` is the pg-boss default (2), not 7.

- [x] **Step 3: Implement queue options**

In `apps/web/src/jobs/boss.ts`:

```ts
import { PgBoss, type Job, type Queue } from "pg-boss";
// …
export type QueueOptions = Partial<
  Pick<
    Queue,
    | "retryLimit"
    | "retryDelay"
    | "retryBackoff"
    | "expireInSeconds"
    | "retentionSeconds"
    | "deadLetter"
  >
>;

interface Registration {
  name: string;
  handler: JobHandler<never>;
  cron?: string;
  queue?: QueueOptions;
}

async function attach(b: PgBoss, { name, handler, cron, queue }: Registration) {
  await b.createQueue(name, queue ? { name, ...queue } : undefined);
  if (queue) await b.updateQueue(name, { name, ...queue }); // createQueue is a no-op when it exists
  if (cron) await b.schedule(name, cron);
  await b.work(name, handler as JobHandler);
}

export function registerQueue<T extends object>(
  name: string,
  handler: JobHandler<T>,
  opts: { cron?: string; queue?: QueueOptions } = {},
) {
  const reg: Registration = {
    name,
    handler,
    cron: opts.cron,
    queue: opts.queue,
  };
  // … unchanged
}
```

Check the exact `createQueue`/`updateQueue`/`getQueue` signatures in `node_modules/pg-boss/dist/index.d.ts` and adjust the option object shape (pg-boss 12 takes `Queue` objects with `name`).

- [x] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun run test:integration -- worker`
Expected: PASS.

- [x] **Step 5: Session hook ordering (opener #5)**

In `apps/web/src/lib/auth.ts`, replace the body of `session.create.before` so it uses the same rule as `resolveTeam`:

```ts
before: async (session) => {
  const { resolveTeam } = await import("@/lib/team");
  const t = await resolveTeam(session.userId, null);
  return { data: { ...session, activeOrganizationId: t?.team.id ?? null } };
},
```

(`resolveTeam` has no `next/*` imports, so this is safe inside the hook.)

- [x] **Step 6: Harness rm retry (opener #7)**

In `apps/web/tests/integration/_pg.ts`, every `rm(dir, { recursive: true, force: true })` becomes `rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })`.

- [x] **Step 7: Verify and commit**

Run: `cd apps/web && bun run test:integration && bun run typecheck`
Expected: all green (auth tests still pass — the second-login test asserts `org_1`, which is the oldest membership).

```bash
git add apps/web/src/jobs/boss.ts apps/web/src/lib/auth.ts apps/web/tests
git commit -m "feat(web): per-queue pg-boss options; session hook uses resolveTeam ordering; harness rm retry"
```

---

### Task 2: Openers — team_settings table and timestamp convention

**Files:**

- Create: `apps/web/src/db/schema/team-settings.ts`
- Modify: `apps/web/src/db/schema/index.ts`, `docs/superpowers/plans/2026-08-24-phase-1-foundation.md` (no), `apps/web/src/db/schema/audit.ts` (comment only)
- Test: `apps/web/tests/integration/db.test.ts`

- [x] **Step 1: Schema**

`apps/web/src/db/schema/team-settings.ts`:

```ts
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";

/**
 * Per-team knobs the spec puts on `teams` (§5). Kept 1:1 with better-auth's
 * `organization` so `schema/auth.ts` stays purely generated.
 * Convention (all Sendsprite tables): timestamps are `withTimezone: true`.
 */
export const teamSettings = pgTable("team_settings", {
  teamId: text("team_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  dailyLimit: integer("daily_limit"),
  monthlyLimit: integer("monthly_limit"),
  trackOpens: boolean("track_opens").notNull().default(true),
  trackClicks: boolean("track_clicks").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
```

Add `export * from "./team-settings";` to `apps/web/src/db/schema/index.ts` (and remove the stale "generated in Task 7" comment).

- [x] **Step 2: Failing test**

Append to `tests/integration/db.test.ts`:

```ts
it("creates team_settings with cascade to organization", async () => {
  const rows = await pg.db.execute(
    sql`select table_name from information_schema.tables where table_schema='public'`,
  );
  expect(rows.map((r) => r.table_name)).toContain("team_settings");
});
```

Run: `cd apps/web && bun run test:integration -- db` → FAIL (table missing).

- [x] **Step 3: Generate migration**

Run: `cd apps/web && bun run db:generate`
Expected: `drizzle/0003_*.sql` with `CREATE TABLE "team_settings"` and the FK.

- [x] **Step 4: Verify and commit**

Run: `cd apps/web && bun run test:integration -- db` → PASS.

```bash
git add apps/web/src/db apps/web/drizzle apps/web/tests/integration/db.test.ts
git commit -m "feat(web): team_settings table; timestamptz convention"
```

---

### Task 3: Openers — audit completeness (organization hooks, request meta, instance self-audit)

**Files:**

- Modify: `apps/web/src/lib/audit.ts`, `apps/web/src/lib/auth.ts`, `apps/web/src/services/team.ts`, `apps/web/src/services/instance-settings.ts`, `apps/web/src/app/app/settings/actions.ts`
- Test: `apps/web/tests/integration/audit-hooks.test.ts`, `apps/web/tests/integration/instance-settings.test.ts`

- [x] **Step 1: Request meta helper**

In `apps/web/src/lib/audit.ts` add:

```ts
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/** Pull client ip / UA from request headers (proxy-aware). No `next/*` import. */
export function requestMeta(h: Headers): RequestMeta {
  // `x-real-ip` wins, then the first hop of `x-forwarded-for`; only trust
  // either behind a proxy that overwrites them.
  const real = h.get("x-real-ip")?.trim();
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return { ip: real || fwd || null, userAgent: h.get("user-agent") };
}
```

and log only `err.message`/`err.code` in the catch (`console.error("[audit] failed", (err as {code?:string}).code, (err as Error).message)`).

- [x] **Step 2: Failing test — hooks write audit rows**

`apps/web/tests/integration/audit-hooks.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_URL = "http://localhost:3000";
  process.env.APP_SECRET = "x".repeat(40);
  process.env.EMAIL_PASSWORD_ENABLED = "true";
  process.env.SIGNUP_MODE = "open";
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
  const { resetAuthForTests } = await import("@/lib/auth");
  resetAuthForTests();
});
afterAll(async () => {
  await pg.stop();
});

async function audits(action: string) {
  const { auditLog } = await import("@/db/schema");
  return pg.db.select().from(auditLog).where(eq(auditLog.action, action));
}

describe("organization hooks → audit", () => {
  it("records team.create on organization creation", async () => {
    const { auth } = await import("@/lib/auth");
    const { headers } = await auth.api.signUpEmail({
      body: {
        email: "h@example.com",
        password: "correct-horse-battery",
        name: "H",
      },
      returnHeaders: true,
    });
    const cookie = headers.get("set-cookie") ?? "";
    const org = await auth.api.createOrganization({
      headers: new Headers({ cookie }),
      body: { name: "Hooked", slug: "hooked" },
    });
    const rows = await audits("team.create");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      teamId: org!.id,
      targetType: "team",
      targetId: org!.id,
    });
  });
});
```

Run: `cd apps/web && bun run test:integration -- audit-hooks` → FAIL (0 rows).

- [x] **Step 3: Wire organization hooks**

In `apps/web/src/lib/auth.ts`, inside `organization({...})`, add (verify hook names/args in `node_modules/better-auth/dist/plugins/organization/*.d.ts`; adjust to the real signatures and report):

```ts
organizationHooks: {
  afterCreateOrganization: async ({ organization: org, user }) => {
    await recordAudit({ teamId: org.id, actorUserId: user.id, action: "team.create", targetType: "team", targetId: org.id, diff: { name: { to: org.name }, slug: { to: org.slug } } });
  },
  afterAcceptInvitation: async ({ invitation: inv, member: m, user }) => {
    await recordAudit({ teamId: inv.organizationId, actorUserId: user.id, action: "members.join", targetType: "member", targetId: m.id, diff: { role: { to: m.role }, invitationId: { to: inv.id } } });
  },
},
```

Import `recordAudit` from `@/lib/audit` (no `next/*` — safe here). Keep the service-layer audit calls for rename/invite/cancel/remove/changeRole (they carry ip/UA; hooks don't).

- [x] **Step 4: ip/UA through the service layer**

`apps/web/src/services/team.ts`: add `meta?: RequestMeta` to `TeamActor`; every `recordAudit({...})` call spreads `...actor.meta`. `apps/web/src/app/app/settings/actions.ts` `actor()` sets `meta: requestMeta(await headers())`.

- [x] **Step 5: Instance self-audit**

`apps/web/src/services/instance-settings.ts`: `updateInstanceSettings(patch, actor?: { userId: string; meta?: RequestMeta })` — after the upsert, `recordAudit({ teamId: null, actorUserId: actor?.userId ?? null, action: "instance.update", targetType: "instance", targetId: "1", diff: computeDiff(beforePlain, afterPlain), ...actor?.meta })` where `beforePlain/afterPlain` are the row minus `id/createdAt/updatedAt`, with `*Enc` columns compared as ciphertext so rotations (set → set) are recorded (`computeDiff` redacts by key, so the log only ever shows `[redacted]`). On a fresh instance the first update lists every column as `{ to: … }`. Add to `instance-settings.test.ts`:

```ts
it("writes an instance-level audit row on update", async () => {
  const { updateInstanceSettings } =
    await import("@/services/instance-settings");
  await updateInstanceSettings({ retentionDays: 30 }, { userId: "u_audit" });
  const { auditLog } = await import("@/db/schema");
  const rows = await pg.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "instance.update"));
  expect(rows.at(-1)).toMatchObject({
    teamId: null,
    actorUserId: "u_audit",
    diff: { retentionDays: { from: 90, to: 30 } },
  });
});
```

- [x] **Step 6: Verify and commit**

Run: `cd apps/web && bun run test:integration && bun run typecheck` → green (team-actions tests unchanged; `meta` is optional).

```bash
git add apps/web/src apps/web/tests
git commit -m "feat(web): audit organization hooks, request meta, instance self-audit"
```

---

### Task 4: Env + schema for provisioning

**Files:**

- Modify: `apps/web/src/env.schema.ts`, `apps/web/src/db/schema/instance.ts`, `.env.example`, `README.md` (env table)
- Create: `apps/web/src/db/schema/setup-tokens.ts`, `apps/web/src/db/schema/domains.ts`
- Test: `apps/web/tests/unit/env.test.ts`, `apps/web/tests/integration/db.test.ts`

- [x] **Step 1: Env additions (failing test first)**

Add to `tests/unit/env.test.ts`:

```ts
it("has provisioning defaults", () => {
  const env = parseEnv(BASE);
  expect(env.CFN_TEMPLATE_URL).toBe(
    "https://sendsprite-cfn.s3.us-east-1.amazonaws.com/latest/sendsprite-connect.yaml",
  );
  expect(env.AWS_DEFAULT_REGION).toBe("us-east-1");
});
it("rejects a non-S3 CFN_TEMPLATE_URL", () => {
  expect(() =>
    parseEnv({
      ...BASE,
      CFN_TEMPLATE_URL: "https://raw.githubusercontent.com/x/y.yaml",
    }),
  ).toThrow(/S3/);
});
```

Run: `cd apps/web && bun run test` → FAIL. Then in `env.schema.ts`:

```ts
CFN_TEMPLATE_URL: z.url().refine((u) => /^https:\/\/([a-z0-9.-]+\.)?s3[.-][a-z0-9-]+\.amazonaws\.com\//.test(u) || /^https:\/\/[a-z0-9.-]+\.s3\.amazonaws\.com\//.test(u), "CFN_TEMPLATE_URL must be an S3 URL (CloudFormation quick-create only accepts S3)").default("https://sendsprite-cfn.s3.us-east-1.amazonaws.com/latest/sendsprite-connect.yaml"),
AWS_DEFAULT_REGION: z.string().default("us-east-1"),
```

Run → PASS. Add both to `.env.example` (commented) and README env table.

- [x] **Step 2: instance_settings additions**

`apps/web/src/db/schema/instance.ts` — add columns:

```ts
awsAccountId: text("aws_account_id"),
snsSubscriptionArn: text("sns_subscription_arn"),
sesReviewStatus: text("ses_review_status", { enum: ["PENDING", "GRANTED", "DENIED", "FAILED"] }),
sesLastCheckedAt: timestamp("ses_last_checked_at", { withTimezone: true }),
cloudflareAccountName: text("cloudflare_account_name"),
cloudflareConnectedAt: timestamp("cloudflare_connected_at", { withTimezone: true }),
awsConnectedAt: timestamp("aws_connected_at", { withTimezone: true }),
```

- [x] **Step 3: setup_tokens and domains**

`apps/web/src/db/schema/setup-tokens.ts`:

```ts
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** One-time tokens for out-of-band callbacks (CloudFormation → Sendsprite). Stored hashed. */
export const setupTokens = pgTable("setup_tokens", {
  id: text("id").primaryKey(), // stok_<ulid>
  purpose: text("purpose", { enum: ["aws_callback"] }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  issuedBy: text("issued_by").notNull(), // user id
  region: text("region").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

`apps/web/src/db/schema/domains.ts`:

```ts
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";

export type DnsRecordKind = "DKIM" | "MAIL_FROM_MX" | "MAIL_FROM_SPF" | "DMARC";
export interface ExpectedRecord {
  kind: DnsRecordKind;
  type: "CNAME" | "MX" | "TXT";
  name: string; // fully-qualified, no trailing dot
  value: string;
  priority?: number; // MX only
  cloudflareId?: string; // set in auto mode after upsert
  ok: boolean; // last check result
}

export const domains = pgTable(
  "domains",
  {
    id: text("id").primaryKey(), // dom_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    region: text("region").notNull(),
    cloudflareZoneId: text("cloudflare_zone_id"),
    dnsMode: text("dns_mode", { enum: ["auto", "manual"] }).notNull(),
    status: text("status", { enum: ["pending", "verified", "failed"] })
      .notNull()
      .default("pending"),
    dkimTokens: jsonb("dkim_tokens").$type<string[]>().notNull().default([]),
    dkimStatus: text("dkim_status"),
    mailFromDomain: text("mail_from_domain").notNull(),
    mailFromStatus: text("mail_from_status"),
    spfOk: boolean("spf_ok").notNull().default(false),
    dmarcOk: boolean("dmarc_ok").notNull().default(false),
    expectedRecords: jsonb("expected_records")
      .$type<ExpectedRecord[]>()
      .notNull()
      .default([]),
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifyUntil: timestamp("verify_until", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("domains_name_uidx").on(t.name),
    index("domains_team_idx").on(t.teamId),
  ],
);
```

Add `"dom"` and `"stok"` to `ID_PREFIXES` in `packages/shared/src/ids.ts` (`dom` exists; add `stok`). Export both tables from `schema/index.ts`.

- [x] **Step 4: Migration + test**

Append to `db.test.ts` the expectation that `setup_tokens` and `domains` exist and that `domains_name_uidx` is unique. Run `bun run db:generate` → `0004_*.sql`. Run `bun run test:integration -- db` → PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web packages/shared .env.example README.md
git commit -m "feat(web): provisioning env, setup_tokens and domains schema"
```

---

### Task 5: AWS credentials, clients, pure helpers (TDD)

**Files:**

- Create: `apps/web/src/lib/aws/credentials.ts`, `apps/web/src/lib/aws/clients.ts`, `apps/web/src/lib/aws/quick-create.ts`, `apps/web/src/lib/aws/ses-account.ts`
- Test: `apps/web/tests/unit/quick-create.test.ts`, `apps/web/tests/unit/ses-account.test.ts`
- Modify: `apps/web/package.json` (deps), `apps/web/next.config.ts` (`serverExternalPackages` += the three AWS clients)

- [x] **Step 1: Install**

Run: `cd apps/web && bun add @aws-sdk/client-sesv2 @aws-sdk/client-sns @aws-sdk/client-sts && bun add -d aws-sdk-client-mock`

- [x] **Step 2: Failing unit tests**

`tests/unit/quick-create.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildQuickCreateUrl } from "@/lib/aws/quick-create";

describe("buildQuickCreateUrl", () => {
  const url = buildQuickCreateUrl({
    region: "eu-west-1",
    templateUrl:
      "https://sendsprite-cfn.s3.us-east-1.amazonaws.com/latest/sendsprite-connect.yaml",
    callbackUrl: "https://mail.acme.com/api/setup/aws/callback",
    callbackToken: "abc123",
    stackName: "sendsprite-connect",
  });
  it("targets the region's console and the quick-create review page", () => {
    expect(
      url.startsWith(
        "https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/create/review?",
      ),
    ).toBe(true);
  });
  it("carries template, stack name and both params URL-encoded", () => {
    const q = new URLSearchParams(url.split("#/stacks/create/review?")[1]);
    expect(q.get("templateURL")).toBe(
      "https://sendsprite-cfn.s3.us-east-1.amazonaws.com/latest/sendsprite-connect.yaml",
    );
    expect(q.get("stackName")).toBe("sendsprite-connect");
    expect(q.get("param_CallbackUrl")).toBe(
      "https://mail.acme.com/api/setup/aws/callback",
    );
    expect(q.get("param_CallbackToken")).toBe("abc123");
  });
  it("rejects non-S3 and look-alike template urls", () => {
    for (const templateUrl of [
      "https://example.com/t.yaml",
      "https://evil.com/s3.amazonaws.com/x.yaml",
      "https://b.s3.amazonaws.com.evil.com/x.yaml",
      "http://b.s3.amazonaws.com/x.yaml",
    ]) {
      expect(() =>
        buildQuickCreateUrl({
          region: "us-east-1",
          templateUrl,
          callbackUrl: "https://x/cb",
          callbackToken: "t",
          stackName: "s",
        }),
      ).toThrow(/S3/);
    }
  });
});
```

`tests/unit/ses-account.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapAccount } from "@/lib/aws/ses-account";

describe("mapAccount", () => {
  it("maps sandbox account", () => {
    expect(
      mapAccount({
        ProductionAccessEnabled: false,
        SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 0 },
      }),
    ).toEqual({
      status: "sandbox",
      reviewStatus: null,
      dailyQuota: 200,
      maxSendRate: 1,
    });
  });
  it("maps pending review", () => {
    expect(
      mapAccount({
        ProductionAccessEnabled: false,
        Details: { ReviewDetails: { Status: "PENDING" } },
        SendQuota: { Max24HourSend: 200, MaxSendRate: 1 },
      }),
    ).toMatchObject({ status: "requested", reviewStatus: "PENDING" });
  });
  it("maps a denied review back to sandbox", () => {
    expect(
      mapAccount({
        ProductionAccessEnabled: false,
        Details: { ReviewDetails: { Status: "DENIED" } },
      }),
    ).toMatchObject({ status: "sandbox", reviewStatus: "DENIED" });
  });
  it("maps production", () => {
    expect(
      mapAccount({
        ProductionAccessEnabled: true,
        SendQuota: { Max24HourSend: 50000, MaxSendRate: 14 },
      }),
    ).toMatchObject({
      status: "production",
      dailyQuota: 50000,
      maxSendRate: 14,
    });
  });
  it("tolerates missing quota", () => {
    expect(mapAccount({ ProductionAccessEnabled: false })).toMatchObject({
      dailyQuota: null,
      maxSendRate: null,
    });
  });
});
```

Run: `cd apps/web && bun run test` → FAIL (modules missing).

- [x] **Step 3: Implement**

`apps/web/src/lib/aws/quick-create.ts`:

```ts
// Accepts virtual-hosted (regional/global) and path-style regional S3 URLs;
// rejects legacy global path-style, dualstack and look-alike hosts.
// `env.schema.ts` reuses this for CFN_TEMPLATE_URL.
const S3_URL =
  /^https:\/\/(([a-z0-9.-]+\.)?s3[.-][a-z0-9-]+|[a-z0-9.-]+\.s3)\.amazonaws\.com\//;
export const isS3TemplateUrl = (url: string): boolean => S3_URL.test(url);

export interface QuickCreateInput {
  region: string;
  templateUrl: string;
  callbackUrl: string;
  callbackToken: string;
  stackName: string;
}

/**
 * CloudFormation quick-create link. AWS only accepts S3 template URLs here,
 * which is why the template is published to a bucket rather than served by
 * the instance. Parameters map to `param_<Name>` and must match the template.
 */
export function buildQuickCreateUrl(i: QuickCreateInput): string {
  if (!isS3TemplateUrl(i.templateUrl))
    throw new Error(
      "templateUrl must be an S3 URL (CloudFormation quick-create only accepts S3)",
    );
  const q = new URLSearchParams({
    templateURL: i.templateUrl,
    stackName: i.stackName,
    param_CallbackUrl: i.callbackUrl,
    param_CallbackToken: i.callbackToken,
  });
  return `https://${i.region}.console.aws.amazon.com/cloudformation/home?region=${i.region}#/stacks/create/review?${q.toString()}`;
}
```

`apps/web/src/lib/aws/ses-account.ts`:

```ts
import type { GetAccountResponse } from "@aws-sdk/client-sesv2";

export type SesAccountStatus = "sandbox" | "requested" | "production";
export type SesReviewStatus = "PENDING" | "GRANTED" | "DENIED" | "FAILED";
export interface SesAccount {
  status: SesAccountStatus;
  reviewStatus: SesReviewStatus | null;
  dailyQuota: number | null;
  maxSendRate: number | null;
}

export function mapAccount(a: GetAccountResponse): SesAccount {
  const review =
    (a.Details?.ReviewDetails?.Status as SesReviewStatus | undefined) ?? null;
  const status: SesAccountStatus = a.ProductionAccessEnabled
    ? "production"
    : review === "PENDING"
      ? "requested"
      : "sandbox";
  return {
    status,
    reviewStatus: review,
    dailyQuota: a.SendQuota?.Max24HourSend ?? null,
    maxSendRate: a.SendQuota?.MaxSendRate ?? null,
  };
}
```

`apps/web/src/lib/aws/credentials.ts`:

```ts
// `@aws-sdk/types` is not hoisted by Bun's isolated linker; derive the
// credential type from the installed client instead.
import type { SESv2ClientConfig } from "@aws-sdk/client-sesv2";
import {
  getInstanceSettings,
  getDecryptedSecrets,
} from "@/services/instance-settings";

export type AwsCredentials = NonNullable<SESv2ClientConfig["credentials"]>;
export interface AwsContext {
  region: string;
  credentials?: AwsCredentials;
}

/**
 * Where AWS calls get their identity from:
 *  - `keys`: stored (encrypted) access key + secret
 *  - `instance_role`: SDK default chain (EC2/ECS/Lambda role, env, profile)
 *  - `none`: throws — callers must check `awsMode` first
 */
export async function resolveAwsContext(): Promise<AwsContext> {
  const s = await getInstanceSettings();
  if (s.awsMode === "none" || !s.awsRegion)
    throw new Error("AWS is not connected");
  if (s.awsMode === "instance_role") return { region: s.awsRegion };
  const sec = await getDecryptedSecrets();
  if (!sec.awsAccessKey || !sec.awsSecret) throw new Error("AWS keys missing");
  return {
    region: s.awsRegion,
    credentials: {
      accessKeyId: sec.awsAccessKey,
      secretAccessKey: sec.awsSecret,
    },
  };
}
```

`apps/web/src/lib/aws/clients.ts`:

```ts
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { SNSClient } from "@aws-sdk/client-sns";
import { STSClient } from "@aws-sdk/client-sts";
import type { AwsContext } from "./credentials";

/** Factories are the seam for tests (aws-sdk-client-mock mocks the classes). */
export const makeSes = (c: AwsContext) =>
  new SESv2Client({ region: c.region, credentials: c.credentials });
export const makeSns = (c: AwsContext) =>
  new SNSClient({ region: c.region, credentials: c.credentials });
export const makeSts = (c: AwsContext) =>
  new STSClient({ region: c.region, credentials: c.credentials });

/** Checked 2026-08-25 against SESv2 regional availability. */
export const SES_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-north-1",
  "eu-south-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "sa-east-1",
  "af-south-1",
  "me-south-1",
  "il-central-1",
  "ap-southeast-3",
  "ap-south-2",
  "eu-central-2",
  "me-central-1",
  "ca-west-1",
  "ap-southeast-5",
] as const;
export type SesRegion = (typeof SES_REGIONS)[number];
```

Add `"@aws-sdk/client-sesv2", "@aws-sdk/client-sns", "@aws-sdk/client-sts"` to `serverExternalPackages` in `next.config.ts`. In `env.schema.ts`, `AWS_DEFAULT_REGION` becomes `z.enum(SES_REGIONS)` and the `CFN_TEMPLATE_URL` refine calls `isS3TemplateUrl` (no duplicated regex; `clients.ts`/`quick-create.ts` must not import env).

- [x] **Step 4: Run tests, commit**

Run: `cd apps/web && bun run test && bun run typecheck` → PASS.

```bash
git add apps/web
git commit -m "feat(web): AWS client factories, credential resolution, quick-create and account mapping"
```

---

### Task 6: Setup tokens service (TDD)

**Files:**

- Create: `apps/web/src/services/setup-tokens.ts`
- Test: `apps/web/tests/integration/setup-tokens.test.ts`

- [x] **Step 1: Failing test**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

describe("setup tokens", () => {
  it("issues a token that can be consumed exactly once", async () => {
    const { issueSetupToken, consumeSetupToken } =
      await import("@/services/setup-tokens");
    const { token, id } = await issueSetupToken({
      purpose: "aws_callback",
      issuedBy: "u1",
      region: "us-east-1",
      ttlMs: 60_000,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    const first = await consumeSetupToken("aws_callback", token);
    expect(first).toMatchObject({ id, region: "us-east-1", issuedBy: "u1" });
    expect(await consumeSetupToken("aws_callback", token)).toBeNull();
  });
  it("rejects expired and unknown tokens", async () => {
    const { issueSetupToken, consumeSetupToken } =
      await import("@/services/setup-tokens");
    const { token } = await issueSetupToken({
      purpose: "aws_callback",
      issuedBy: "u1",
      region: "us-east-1",
      ttlMs: -1,
    });
    expect(await consumeSetupToken("aws_callback", token)).toBeNull();
    expect(await consumeSetupToken("aws_callback", "nope")).toBeNull();
  });
});
```

`setup_tokens.issued_by` is a FK to `user.id` (cascade; migration `0005`), so the test's `beforeAll` inserts `user` rows. Also cover: two concurrent `consumeSetupToken` calls → exactly one wins; `pendingSetupToken` returns the newest; deleting the user drops its tokens.

Run: `cd apps/web && bun run test:integration -- setup-tokens` → FAIL.

- [x] **Step 2: Implement**

`apps/web/src/services/setup-tokens.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { newId } from "@sendsprite/shared";
import { db } from "@/db";
import { setupTokens } from "@/db/schema";

type Purpose = "aws_callback";
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function issueSetupToken(i: {
  purpose: Purpose;
  issuedBy: string;
  region: string;
  ttlMs: number;
}) {
  const token = randomBytes(32).toString("base64url");
  const id = newId("stok");
  await db()
    .insert(setupTokens)
    .values({
      id,
      purpose: i.purpose,
      tokenHash: hash(token),
      issuedBy: i.issuedBy,
      region: i.region,
      expiresAt: new Date(Date.now() + i.ttlMs),
    });
  return { token, id };
}

/** Atomically marks the token consumed; null when unknown, expired or already used. */
export async function consumeSetupToken(purpose: Purpose, token: string) {
  const [row] = await db()
    .update(setupTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(setupTokens.purpose, purpose),
        eq(setupTokens.tokenHash, hash(token)),
        isNull(setupTokens.consumedAt),
        gt(setupTokens.expiresAt, sql`now()`),
      ),
    )
    .returning();
  return row ?? null;
}

/** Newest unconsumed, unexpired token for the wizard's status poll. */
export async function pendingSetupToken(purpose: Purpose, issuedBy: string) {
  const [row] = await db()
    .select()
    .from(setupTokens)
    .where(
      and(
        eq(setupTokens.purpose, purpose),
        eq(setupTokens.issuedBy, issuedBy),
        isNull(setupTokens.consumedAt),
        gt(setupTokens.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(setupTokens.createdAt), desc(setupTokens.id))
    .limit(1);
  return row ?? null;
}
```

- [x] **Step 3: Verify, commit**

Run → PASS. `git add apps/web && git commit -m "feat(web): one-time setup tokens"`

---

### Task 7: AWS connect service (TDD with aws-sdk-client-mock)

**Files:**

- Create: `apps/web/src/services/aws-connect.ts`
- Test: `apps/web/tests/integration/aws-connect.test.ts`

- [x] **Step 1: Failing test**

```ts
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { eq } from "drizzle-orm";
import {
  SESv2Client,
  GetAccountCommand,
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  PutAccountDetailsCommand,
  UpdateConfigurationSetEventDestinationCommand,
} from "@aws-sdk/client-sesv2";
import {
  SNSClient,
  CreateTopicCommand,
  SubscribeCommand,
  UnsubscribeCommand,
} from "@aws-sdk/client-sns";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { auditLog } from "@/db/schema";
import { startPg } from "./_pg";

const ses = mockClient(SESv2Client);
const sns = mockClient(SNSClient);
const sts = mockClient(STSClient);

const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:sendsprite-events";
const SUB_ARN = `${TOPIC_ARN}:6b0e71bd-7e97-4d97-80ce-4a0994e55286`;
const KEYS = {
  accessKeyId: "AKIAEXAMPLEEXAMPLE",
  secretAccessKey: "s3cr3ts3cr3ts3cr3ts3cr3t",
  region: "us-east-1",
};
const awsErr = (name: string, message: string) =>
  Object.assign(new Error(message), { name });

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
});
afterAll(async () => {
  await pg.stop();
});
/** Every test starts from a disconnected instance and sets its own precondition. */
beforeEach(async () => {
  const { updateInstanceSettings } =
    await import("@/services/instance-settings");
  await updateInstanceSettings(
    {
      awsMode: "none",
      awsRegion: null,
      awsAccessKey: null,
      awsSecret: null,
      awsAccountId: null,
      awsConnectedAt: null,
      snsTopicArn: null,
      snsSubscriptionArn: null,
      sesConfigSet: null,
      sesAccountStatus: null,
      sesReviewStatus: null,
      sesDailyQuota: null,
      sesMaxSendRate: null,
      sesLastCheckedAt: null,
    },
    undefined,
    { audit: false },
  );
  await pg.db.delete(auditLog);
});
afterEach(() => {
  ses.reset();
  sns.reset();
  sts.reset();
});

function happyMocks() {
  sts.on(GetCallerIdentityCommand).resolves({
    Account: "123456789012",
    Arn: "arn:aws:iam::123456789012:user/sendsprite",
  });
  ses.on(GetAccountCommand).resolves({
    ProductionAccessEnabled: false,
    SendQuota: { Max24HourSend: 200, MaxSendRate: 1 },
  });
  ses.on(CreateConfigurationSetCommand).resolves({});
  ses.on(CreateConfigurationSetEventDestinationCommand).resolves({});
  sns.on(CreateTopicCommand).resolves({ TopicArn: TOPIC_ARN });
  sns.on(SubscribeCommand).resolves({ SubscriptionArn: SUB_ARN });
}

async function settings() {
  const { getInstanceSettings } = await import("@/services/instance-settings");
  return getInstanceSettings();
}
async function instanceAudits() {
  return pg.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "instance.update"));
}

describe("connectWithKeys", () => {
  it("returns a Result error (no state change) when credentials are rejected", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .rejects(
        awsErr(
          "InvalidClientTokenId",
          "The security token included in the request is invalid.",
        ),
      );
    const { connectWithKeys } = await import("@/services/aws-connect");
    const res = await connectWithKeys(
      { ...KEYS, accessKeyId: "AKIABADBADBADBAD" },
      { userId: "u1" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/security token/i);
    expect(await settings()).toMatchObject({
      awsMode: "none",
      awsAccessKeyEnc: null,
    });
  });
  it("rejects malformed input (short keys, unsupported region) without calling AWS", async () => {
    const { connectWithKeys } = await import("@/services/aws-connect");
    for (const input of [
      { accessKeyId: "short", secretAccessKey: "short", region: "us-east-1" },
      { ...KEYS, region: "mars-north-1" },
    ]) {
      expect((await connectWithKeys(input, { userId: "u1" })).ok).toBe(false);
    }
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0);
  });
  it("verifies, stores encrypted keys, provisions SES infra, records account", async () => {
    happyMocks();
    const { connectWithKeys, EVENT_TYPES } =
      await import("@/services/aws-connect");
    const res = await connectWithKeys(KEYS, { userId: "u1" });
    expect(res).toEqual({
      ok: true,
      data: { accountId: "123456789012", status: "sandbox" },
    });
    const { getDecryptedSecrets } =
      await import("@/services/instance-settings");
    const s = await settings();
    expect(s).toMatchObject({
      awsMode: "keys",
      awsRegion: "us-east-1",
      awsAccountId: "123456789012",
      sesConfigSet: "sendsprite",
      snsTopicArn: TOPIC_ARN,
      snsSubscriptionArn: SUB_ARN,
      sesAccountStatus: "sandbox",
      sesDailyQuota: 200,
      sesMaxSendRate: 1,
    });
    expect(s.awsConnectedAt).toBeInstanceOf(Date);
    expect(s.awsAccessKeyEnc).toMatch(/^v1\./);
    expect(await getDecryptedSecrets()).toMatchObject({
      awsAccessKey: KEYS.accessKeyId,
      awsSecret: KEYS.secretAccessKey,
    });
    const dest = ses.commandCalls(
      CreateConfigurationSetEventDestinationCommand,
    )[0]!.args[0].input;
    expect(dest).toMatchObject({
      ConfigurationSetName: "sendsprite",
      EventDestination: {
        Enabled: true,
        SnsDestination: { TopicArn: TOPIC_ARN },
      },
    });
    expect(dest.EventDestination?.MatchingEventTypes).toEqual([...EVENT_TYPES]);
    expect(sns.commandCalls(SubscribeCommand)[0]!.args[0].input).toEqual({
      TopicArn: TOPIC_ARN,
      Protocol: "https",
      Endpoint: "https://mail.acme.com/api/webhooks/ses",
      ReturnSubscriptionArn: true,
    });
    // One audited write for the connection; the subscription ARN is bookkeeping.
    expect(await instanceAudits()).toHaveLength(1);
  });
  it("persists the topic ARN before subscribing (confirmation POST can race Subscribe)", async () => {
    happyMocks();
    sns.on(SubscribeCommand).callsFake(async () => {
      expect(await settings()).toMatchObject({
        awsMode: "keys",
        snsTopicArn: TOPIC_ARN,
        snsSubscriptionArn: null,
      });
      return { SubscriptionArn: SUB_ARN };
    });
    const { connectWithKeys } = await import("@/services/aws-connect");
    expect((await connectWithKeys(KEYS, { userId: "u1" })).ok).toBe(true);
    expect(sns.commandCalls(SubscribeCommand)).toHaveLength(1);
    expect((await settings()).snsSubscriptionArn).toBe(SUB_ARN);
  });
  it("waits out IAM propagation: STS rejects twice, then connects", async () => {
    happyMocks();
    sts
      .on(GetCallerIdentityCommand)
      .rejectsOnce(awsErr("InvalidClientTokenId", "invalid token"))
      .rejectsOnce(awsErr("InvalidSignatureException", "bad signature"))
      .resolves({ Account: "123456789012" });
    const { connectWithKeys, setSleepForTests } =
      await import("@/services/aws-connect");
    const slept: number[] = [];
    setSleepForTests(async (ms) => {
      slept.push(ms);
    });
    try {
      expect((await connectWithKeys(KEYS, { userId: "u1" })).ok).toBe(true);
    } finally {
      setSleepForTests((ms) => new Promise((r) => setTimeout(r, ms)));
    }
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(3);
    expect(slept).toEqual([3000, 3000]);
    expect((await settings()).awsMode).toBe("keys");
  });
  it("gives up after 5 propagation failures (≤ 15 s budget) with no state and the error code", async () => {
    happyMocks();
    sts
      .on(GetCallerIdentityCommand)
      .rejects(awsErr("InvalidClientTokenId", "invalid token"));
    const { connectWithKeys, setSleepForTests } =
      await import("@/services/aws-connect");
    setSleepForTests(async () => {});
    try {
      const res = await connectWithKeys(KEYS, { userId: "u1" });
      expect(res).toMatchObject({ ok: false, code: "InvalidClientTokenId" });
    } finally {
      setSleepForTests((ms) => new Promise((r) => setTimeout(r, ms)));
    }
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(5);
    expect((await settings()).awsMode).toBe("none");
    expect(await instanceAudits()).toHaveLength(0);
  });
  it("refuses to connect over a live connection (disconnect first)", async () => {
    happyMocks();
    const { connectWithKeys, detectInstanceRole } =
      await import("@/services/aws-connect");
    expect((await connectWithKeys(KEYS, { userId: "u1" })).ok).toBe(true);
    sts.resetHistory();
    const refused = {
      ok: false,
      code: "ALREADY_CONNECTED",
      error: expect.stringMatching(/already connected/i),
    };
    expect(
      await connectWithKeys(
        { ...KEYS, accessKeyId: "AKIAOTHEROTHEROTHER" },
        { userId: "u1" },
      ),
    ).toEqual(refused);
    expect(await detectInstanceRole("eu-west-1", { userId: "u1" })).toEqual(
      refused,
    );
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0);
    expect(await settings()).toMatchObject({
      awsMode: "keys",
      awsRegion: "us-east-1",
    });
    expect(await instanceAudits()).toHaveLength(1);
  });
  it("stays connected with a warning when Subscribe fails (no rollback trap)", async () => {
    happyMocks();
    sns
      .on(SubscribeCommand)
      .rejects(awsErr("AuthorizationError", "not authorized: SNS:Subscribe"));
    const { connectWithKeys } = await import("@/services/aws-connect");
    const res = await connectWithKeys(KEYS, { userId: "u1" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.warning).toContain("SES event subscription");
    expect(await settings()).toMatchObject({
      awsMode: "keys",
      snsTopicArn: TOPIC_ARN,
      snsSubscriptionArn: null,
    });
  });
  it("converges when the config set and event destination already exist", async () => {
    happyMocks();
    ses
      .on(CreateConfigurationSetCommand)
      .rejects(awsErr("AlreadyExistsException", "exists"));
    ses
      .on(CreateConfigurationSetEventDestinationCommand)
      .rejects(awsErr("AlreadyExistsException", "exists"));
    ses.on(UpdateConfigurationSetEventDestinationCommand).resolves({});
    const { connectWithKeys } = await import("@/services/aws-connect");
    expect((await connectWithKeys(KEYS, { userId: "u1" })).ok).toBe(true);
    const update = ses.commandCalls(
      UpdateConfigurationSetEventDestinationCommand,
    );
    expect(update).toHaveLength(1);
    expect(update[0]!.args[0].input).toEqual(
      ses.commandCalls(CreateConfigurationSetEventDestinationCommand)[0]!
        .args[0].input,
    );
  });
  it("leaves the instance disconnected when provisioning fails part-way", async () => {
    happyMocks();
    sns
      .on(CreateTopicCommand)
      .rejects(
        awsErr(
          "AccessDeniedException",
          "User is not authorized to perform: sns:CreateTopic",
        ),
      );
    const { connectWithKeys } = await import("@/services/aws-connect");
    const res = await connectWithKeys(KEYS, { userId: "u1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/sns:CreateTopic/);
      expect(res.error).not.toContain(KEYS.secretAccessKey);
    }
    expect(await settings()).toMatchObject({
      awsMode: "none",
      awsAccessKeyEnc: null,
      awsSecretEnc: null,
      snsTopicArn: null,
    });
    expect(await instanceAudits()).toHaveLength(0);
  });
  it("skips the SNS subscription when APP_URL is not https (local dev)", async () => {
    happyMocks();
    const { resetEnvCache } = await import("@/env.schema");
    process.env.APP_URL = "http://localhost:3000";
    resetEnvCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { connectWithKeys } = await import("@/services/aws-connect");
      expect((await connectWithKeys(KEYS, { userId: "u1" })).ok).toBe(true);
      expect(sns.commandCalls(SubscribeCommand)).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/https/i));
      expect(await settings()).toMatchObject({
        snsTopicArn: TOPIC_ARN,
        snsSubscriptionArn: null,
      });
    } finally {
      warn.mockRestore();
      process.env.APP_URL = "https://mail.acme.com";
      resetEnvCache();
    }
  });
});

describe("requestProductionAccess / refreshSesAccount", () => {
  async function connected() {
    happyMocks();
    const { connectWithKeys } = await import("@/services/aws-connect");
    expect((await connectWithKeys(KEYS, { userId: "u1" })).ok).toBe(true);
    await pg.db.delete(auditLog);
  }
  it("submits details and flips status to requested", async () => {
    await connected();
    ses.on(PutAccountDetailsCommand).resolves({});
    ses.on(GetAccountCommand).resolves({
      ProductionAccessEnabled: false,
      Details: { ReviewDetails: { Status: "PENDING" } },
      SendQuota: { Max24HourSend: 200, MaxSendRate: 1 },
    });
    const { requestProductionAccess } = await import("@/services/aws-connect");
    const res = await requestProductionAccess(
      {
        websiteUrl: "https://acme.com",
        mailType: "TRANSACTIONAL",
        useCase: "Order receipts and password resets.",
        contactEmail: "ops@acme.com",
      },
      { userId: "u1" },
    );
    expect(res).toEqual({ ok: true, data: { status: "requested" } });
    expect(
      ses.commandCalls(PutAccountDetailsCommand)[0]!.args[0].input,
    ).toMatchObject({
      MailType: "TRANSACTIONAL",
      WebsiteURL: "https://acme.com",
      ProductionAccessEnabled: true,
      AdditionalContactEmailAddresses: ["ops@acme.com"],
    });
    expect(await settings()).toMatchObject({
      sesAccountStatus: "requested",
      sesReviewStatus: "PENDING",
    });
    expect(await instanceAudits()).toHaveLength(1);
  });
  it("rejects an invalid request before calling SES", async () => {
    const { requestProductionAccess } = await import("@/services/aws-connect");
    const res = await requestProductionAccess(
      { websiteUrl: "acme", mailType: "OTHER", useCase: "short" },
      { userId: "u1" },
    );
    expect(res.ok).toBe(false);
    expect(ses.commandCalls(PutAccountDetailsCommand)).toHaveLength(0);
  });
  it("says so when the request went through but the status read failed", async () => {
    await connected();
    ses.on(PutAccountDetailsCommand).resolves({});
    ses
      .on(GetAccountCommand)
      .rejects(awsErr("TooManyRequestsException", "Rate exceeded"));
    const { requestProductionAccess } = await import("@/services/aws-connect");
    const res = await requestProductionAccess(
      {
        websiteUrl: "https://acme.com",
        mailType: "MARKETING",
        useCase: "Weekly newsletter for opted-in subscribers.",
      },
      { userId: "u1" },
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringMatching(/^Request submitted, but .*Rate exceeded/),
    });
    expect(ses.commandCalls(PutAccountDetailsCommand)).toHaveLength(1);
  });
  it("refreshSesAccount audits a change once and stays quiet when nothing changed", async () => {
    await connected();
    ses.on(GetAccountCommand).resolves({
      ProductionAccessEnabled: true,
      Details: { ReviewDetails: { Status: "GRANTED" } },
      SendQuota: { Max24HourSend: 50000, MaxSendRate: 14 },
    });
    const { refreshSesAccount } = await import("@/services/aws-connect");
    expect(await refreshSesAccount({ userId: "u1" })).toEqual({
      ok: true,
      data: { status: "production" },
    });
    const first = await settings();
    expect(first).toMatchObject({
      sesAccountStatus: "production",
      sesReviewStatus: "GRANTED",
      sesDailyQuota: 50000,
      sesMaxSendRate: 14,
    });
    expect(await instanceAudits()).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 5));
    expect((await refreshSesAccount()).ok).toBe(true);
    const second = await settings();
    expect(second.sesLastCheckedAt!.getTime()).toBeGreaterThan(
      first.sesLastCheckedAt!.getTime(),
    );
    expect(await instanceAudits()).toHaveLength(1);
  });
});

describe("detectInstanceRole", () => {
  // aws-sdk-client-mock answers STS before the SDK resolves credentials, so
  // this exercises the connect path, not IMDS / the default-chain lookup.
  it("connects with instance role when the default chain works", async () => {
    happyMocks();
    const { detectInstanceRole } = await import("@/services/aws-connect");
    const res = await detectInstanceRole("us-east-1", { userId: "u1" });
    expect(res).toMatchObject({
      ok: true,
      data: { accountId: "123456789012" },
    });
    expect(await settings()).toMatchObject({
      awsMode: "instance_role",
      awsAccessKeyEnc: null,
      awsSecretEnc: null,
    });
  });
  it("returns a friendly ok:false when no credentials are available", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .rejects(
        awsErr(
          "CredentialsProviderError",
          "Could not load credentials from any providers",
        ),
      );
    const { detectInstanceRole } = await import("@/services/aws-connect");
    expect(await detectInstanceRole("us-east-1", { userId: "u1" })).toEqual({
      ok: false,
      error: expect.stringMatching(/^No AWS credentials found on this host/),
    });
    expect((await settings()).awsMode).toBe("none");
  });
});

describe("disconnectAws", () => {
  it("unsubscribes, forgets credentials and SES state, then refuses a second disconnect", async () => {
    happyMocks();
    sns.on(UnsubscribeCommand).resolves({});
    const { connectWithKeys, disconnectAws } =
      await import("@/services/aws-connect");
    expect((await connectWithKeys(KEYS, { userId: "u1" })).ok).toBe(true);
    expect(await disconnectAws({ userId: "u1" })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(sns.commandCalls(UnsubscribeCommand)[0]!.args[0].input).toEqual({
      SubscriptionArn: SUB_ARN,
    });
    expect(await settings()).toMatchObject({
      awsMode: "none",
      awsAccountId: null,
      awsAccessKeyEnc: null,
      snsTopicArn: null,
      snsSubscriptionArn: null,
      sesConfigSet: null,
      sesAccountStatus: null,
    });
    expect((await disconnectAws({ userId: "u1" })).ok).toBe(false);
  });
  it("still disconnects when Unsubscribe fails", async () => {
    happyMocks();
    sns
      .on(UnsubscribeCommand)
      .rejects(awsErr("AuthorizationError", "not authorized"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { connectWithKeys, disconnectAws } =
        await import("@/services/aws-connect");
      expect((await connectWithKeys(KEYS, { userId: "u1" })).ok).toBe(true);
      expect((await disconnectAws({ userId: "u1" })).ok).toBe(true);
      expect((await settings()).awsMode).toBe("none");
    } finally {
      warn.mockRestore();
    }
  });
});
```

Run: `cd apps/web && bun run test:integration -- aws-connect` → FAIL (`Cannot find package '@/services/aws-connect'`).

- [x] **Step 2: Implement**

`apps/web/src/services/aws-connect.ts`:

```ts
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  GetAccountCommand,
  PutAccountDetailsCommand,
  UpdateConfigurationSetEventDestinationCommand,
  type EventDestinationDefinition,
} from "@aws-sdk/client-sesv2";
import {
  CreateTopicCommand,
  SubscribeCommand,
  UnsubscribeCommand,
} from "@aws-sdk/client-sns";
import { z } from "zod";
// Not `@/env`: that module is `server-only` and throws under vitest.
import { loadEnv } from "@/env.schema";
import { makeSes, makeSns, makeSts } from "@/lib/aws/clients";
import type { AwsContext } from "@/lib/aws/credentials";
import { resolveAwsContext } from "@/lib/aws/credentials";
import { SES_REGIONS } from "@/lib/aws/regions";
import { mapAccount, type SesAccount } from "@/lib/aws/ses-account";
import type { Result } from "@/lib/result";
import {
  getInstanceSettings,
  updateInstanceSettings,
  type InstanceActor,
  type InstanceSettings,
} from "./instance-settings";

export const CONFIG_SET = "sendsprite";
export const TOPIC_NAME = "sendsprite-events";
const EVENT_DESTINATION = "sendsprite-sns";
export const EVENT_TYPES = [
  "SEND",
  "REJECT",
  "BOUNCE",
  "COMPLAINT",
  "DELIVERY",
  "OPEN",
  "CLICK",
  "RENDERING_FAILURE",
  "DELIVERY_DELAY",
  "SUBSCRIPTION",
] as const;

export type Actor = InstanceActor;

type Connected = {
  accountId: string;
  status: string;
  /** Set when the connection was persisted but the SES event subscription failed. */
  warning?: string;
};

const errName = (e: unknown) => (e as { name?: string })?.name;
const isAlreadyExists = (e: unknown) => errName(e) === "AlreadyExistsException";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Test hook: replace the propagation-retry sleep. */
export function setSleepForTests(fn: typeof sleep) {
  sleep = fn;
}

/** Errors a freshly created IAM key produces until it has propagated. */
const PROPAGATION_ERRORS = new Set([
  "InvalidClientTokenId",
  "InvalidSignatureException",
  "AuthFailure",
]);
// 5 attempts × 3 s = 12 s of sleeping, ≤ 15 s in total with the calls
// themselves. Keep it there: the CloudFormation Lambda's POST timeout is 45 s
// (infra/aws/sendsprite-connect.yaml) and it does not retry (single-use
// token), so the rest of the connect (config set, topic, subscribe) must fit
// in the remaining budget.
const PROPAGATION_ATTEMPTS = 5;
const PROPAGATION_DELAY_MS = 3_000;

/**
 * STS + GetAccount. A key created seconds ago (the CloudFormation Lambda)
 * can be rejected until IAM propagates it, so both calls are retried on
 * propagation errors within the budget above.
 */
async function verifyIdentity(ctx: AwsContext) {
  for (let attempt = 1; ; attempt++) {
    try {
      const id = await makeSts(ctx).send(new GetCallerIdentityCommand({}));
      if (!id.Account) throw new Error("STS returned no account id");
      const account = await makeSes(ctx).send(new GetAccountCommand({}));
      return { accountId: id.Account, account: mapAccount(account) };
    } catch (e) {
      const name = errName(e);
      if (
        !name ||
        !PROPAGATION_ERRORS.has(name) ||
        attempt >= PROPAGATION_ATTEMPTS
      )
        throw e;
      await sleep(PROPAGATION_DELAY_MS);
    }
  }
}

/**
 * Config set + SNS topic + event destination. Convergent: an existing config
 * set is fine, CreateTopic is idempotent by name, and an existing event
 * destination is updated to the current definition.
 */
export async function ensureSesInfrastructure(
  ctx: AwsContext,
): Promise<{ topicArn: string }> {
  const ses = makeSes(ctx);
  const sns = makeSns(ctx);
  try {
    await ses.send(
      new CreateConfigurationSetCommand({ ConfigurationSetName: CONFIG_SET }),
    );
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  }
  const topic = await sns.send(new CreateTopicCommand({ Name: TOPIC_NAME }));
  if (!topic.TopicArn) throw new Error("SNS returned no topic ARN");
  const topicArn = topic.TopicArn;
  const destination = {
    ConfigurationSetName: CONFIG_SET,
    EventDestinationName: EVENT_DESTINATION,
    EventDestination: {
      Enabled: true,
      MatchingEventTypes: [...EVENT_TYPES],
      SnsDestination: { TopicArn: topicArn },
    } satisfies EventDestinationDefinition,
  };
  try {
    await ses.send(
      new CreateConfigurationSetEventDestinationCommand(destination),
    );
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
    await ses.send(
      new UpdateConfigurationSetEventDestinationCommand(destination),
    );
  }
  return { topicArn };
}

/**
 * Subscribe the SES webhook to the topic. SNS only accepts https endpoints,
 * so with a non-https APP_URL (local dev) nothing is subscribed and null is
 * returned. Confirmation happens when SNS POSTs to the endpoint (Task 9).
 */
export async function subscribeEndpoint(
  ctx: AwsContext,
  topicArn: string,
): Promise<string | null> {
  const endpoint = `${loadEnv().APP_URL}/api/webhooks/ses`;
  if (!endpoint.startsWith("https://")) {
    console.warn(
      `aws-connect: APP_URL is not https; skipping SNS subscription to ${endpoint}. SES events will not be delivered.`,
    );
    return null;
  }
  const sub = await makeSns(ctx).send(
    new SubscribeCommand({
      TopicArn: topicArn,
      Protocol: "https",
      Endpoint: endpoint,
      ReturnSubscriptionArn: true,
    }),
  );
  return sub.SubscriptionArn ?? null;
}

const accountPatch = (a: SesAccount) => ({
  sesAccountStatus: a.status,
  sesReviewStatus: a.reviewStatus,
  sesDailyQuota: a.dailyQuota,
  sesMaxSendRate: a.maxSendRate,
});

/**
 * Verify → provision → persist → subscribe. The topic ARN is stored before
 * SubscribeCommand runs so the confirmation POST (which can arrive before
 * Subscribe returns) finds it; the subscription ARN is a bookkeeping write.
 */
async function finishConnect(
  ctx: AwsContext,
  mode: "keys" | "instance_role",
  keys: { accessKeyId: string; secretAccessKey: string } | null,
  actor: Actor,
): Promise<Result<Connected>> {
  const { accountId, account } = await verifyIdentity(ctx);
  const { topicArn } = await ensureSesInfrastructure(ctx);
  const now = new Date();
  await updateInstanceSettings(
    {
      awsMode: mode,
      awsRegion: ctx.region,
      awsAccountId: accountId,
      awsConnectedAt: now,
      awsAccessKey: keys?.accessKeyId ?? null,
      awsSecret: keys?.secretAccessKey ?? null,
      sesConfigSet: CONFIG_SET,
      snsTopicArn: topicArn,
      snsSubscriptionArn: null,
      ...accountPatch(account),
      sesLastCheckedAt: now,
    },
    actor,
  );
  // Past this point the connection is persisted and consistent. A subscribe
  // failure is reported as a warning rather than an error so a caller (the
  // CloudFormation callback) does not roll back a working connection.
  let warning: string | undefined;
  try {
    const snsSubscriptionArn = await subscribeEndpoint(ctx, topicArn);
    await updateInstanceSettings({ snsSubscriptionArn }, undefined, {
      audit: false,
    });
  } catch (e) {
    console.warn("aws-connect: SNS subscribe failed:", errMsg(e));
    warning = `Connected, but the SES event subscription could not be created: ${errMsg(e)}. Reconnect or fix SNS permissions; sending still works.`;
  }
  return {
    ok: true,
    data: { accountId, status: account.status, ...(warning && { warning }) },
  };
}

/** Connecting over a live connection would silently replace it. */
const ALREADY_CONNECTED: Result<never> = {
  ok: false,
  code: "ALREADY_CONNECTED",
  error: "AWS is already connected. Disconnect first to replace it.",
};

const keysSchema = z.object({
  accessKeyId: z.string().min(16).max(128),
  secretAccessKey: z.string().min(16).max(128),
  region: z.enum(SES_REGIONS),
});

export async function connectWithKeys(
  input: unknown,
  actor: Actor,
): Promise<Result<Connected>> {
  const parsed = keysSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      error: "Access key, secret and a supported SES region are required.",
    };
  const { accessKeyId, secretAccessKey, region } = parsed.data;
  if ((await getInstanceSettings()).awsMode !== "none")
    return ALREADY_CONNECTED;
  try {
    return await finishConnect(
      { region, credentials: { accessKeyId, secretAccessKey } },
      "keys",
      { accessKeyId, secretAccessKey },
      actor,
    );
  } catch (e) {
    return {
      ok: false,
      error: `AWS rejected the connection: ${errMsg(e)}`,
      code: errName(e),
    };
  }
}

/** Try the SDK default credential chain (EC2/ECS role, env, profile). Never throws. */
export async function detectInstanceRole(
  region: string,
  actor: Actor,
): Promise<Result<Connected>> {
  if ((await getInstanceSettings()).awsMode !== "none")
    return ALREADY_CONNECTED;
  try {
    return await finishConnect({ region }, "instance_role", null, actor);
  } catch (e) {
    if (errName(e) === "CredentialsProviderError")
      return {
        ok: false,
        error:
          "No AWS credentials found on this host. Run on EC2/ECS with a role attached, or use one-click / manual keys.",
      };
    return {
      ok: false,
      error: `No usable AWS credentials on this host: ${errMsg(e)}`,
    };
  }
}

const accountUnchanged = (s: InstanceSettings, a: SesAccount) =>
  s.sesAccountStatus === a.status &&
  s.sesReviewStatus === a.reviewStatus &&
  s.sesDailyQuota === a.dailyQuota &&
  s.sesMaxSendRate === a.maxSendRate;

/**
 * Re-read GetAccount. Only a real change is audited; otherwise (the hourly
 * job, most of the time) just `sesLastCheckedAt` is bumped, unaudited.
 */
export async function refreshSesAccount(
  actor?: Actor,
): Promise<Result<{ status: string }>> {
  try {
    const ctx = await resolveAwsContext();
    const account = mapAccount(
      await makeSes(ctx).send(new GetAccountCommand({})),
    );
    const current = await getInstanceSettings();
    const now = new Date();
    if (accountUnchanged(current, account)) {
      await updateInstanceSettings({ sesLastCheckedAt: now }, undefined, {
        audit: false,
      });
    } else {
      await updateInstanceSettings(
        { ...accountPatch(account), sesLastCheckedAt: now },
        actor,
      );
    }
    return { ok: true, data: { status: account.status } };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

const prodSchema = z.object({
  websiteUrl: z.url(),
  mailType: z.enum(["TRANSACTIONAL", "MARKETING"]),
  useCase: z.string().min(20).max(5000),
  contactEmail: z.email().optional(),
});

export async function requestProductionAccess(
  input: unknown,
  actor: Actor,
): Promise<Result<{ status: string }>> {
  const p = prodSchema.safeParse(input);
  if (!p.success)
    return {
      ok: false,
      error:
        "Website URL, mail type and a use-case description (20+ chars) are required.",
    };
  try {
    const ctx = await resolveAwsContext();
    await makeSes(ctx).send(
      new PutAccountDetailsCommand({
        MailType: p.data.mailType,
        WebsiteURL: p.data.websiteUrl,
        UseCaseDescription: p.data.useCase,
        ContactLanguage: "EN",
        ProductionAccessEnabled: true,
        ...(p.data.contactEmail && {
          AdditionalContactEmailAddresses: [p.data.contactEmail],
        }),
      }),
    );
  } catch (e) {
    return { ok: false, error: `SES rejected the request: ${errMsg(e)}` };
  }
  const refreshed = await refreshSesAccount(actor);
  if (!refreshed.ok)
    return {
      ok: false,
      error: `Request submitted, but the status could not be read yet: ${refreshed.error}`,
    };
  return refreshed;
}

/**
 * Forget credentials and SES state. The config set, topic and event
 * destination were created through the API (not by the CloudFormation
 * stack), so they stay in the account; the endpoint subscription is removed
 * best-effort so SNS stops posting to this instance.
 */
export async function disconnectAws(actor: Actor): Promise<Result> {
  const s = await getInstanceSettings();
  if (s.awsMode === "none")
    return { ok: false, error: "AWS is not connected." };
  if (s.snsSubscriptionArn) {
    try {
      const ctx = await resolveAwsContext();
      await makeSns(ctx).send(
        new UnsubscribeCommand({ SubscriptionArn: s.snsSubscriptionArn }),
      );
    } catch (e) {
      console.warn("aws-connect: unsubscribe failed, continuing:", errMsg(e));
    }
  }
  await updateInstanceSettings(
    {
      awsMode: "none",
      awsAccessKey: null,
      awsSecret: null,
      awsAccountId: null,
      awsConnectedAt: null,
      snsTopicArn: null,
      snsSubscriptionArn: null,
      sesConfigSet: null,
      sesAccountStatus: null,
      sesReviewStatus: null,
      sesDailyQuota: null,
      sesMaxSendRate: null,
      sesLastCheckedAt: null,
    },
    actor,
  );
  return { ok: true, data: undefined };
}
```

Move `Result` to `apps/web/src/lib/result.ts` (`export type Result<T = undefined> = …`) and re-export from `services/team.ts` so both services share it without a circular import.

Supporting changes made with this task (from review):

- `services/instance-settings.ts`: export `InstanceActor`; `updateInstanceSettings(patch, actor?, opts?: { audit?: boolean })` — `audit: false` skips the audit row for bookkeeping writes (`sesLastCheckedAt`, `snsSubscriptionArn`).
- `ensureSesInfrastructure` returns only `{ topicArn }`; `subscribeEndpoint(ctx, topicArn)` is separate so the topic ARN is persisted _before_ `SubscribeCommand` (the confirmation POST can race it). Existing event destination → `UpdateConfigurationSetEventDestinationCommand` with the same payload.
- `refreshSesAccount` audits only when the mapped account differs from the stored columns.
- `disconnectAws` best-effort `UnsubscribeCommand` before clearing state.
- `lib/aws/regions.ts` holds `SES_REGIONS` (no SDK import from `env.schema.ts`); `keysSchema.region` is `z.enum(SES_REGIONS)`.
- `tests/integration/_pg.ts`: temp-dir cleanup failure (Windows EBUSY) is a warning, not a test failure.

- [x] **Step 3: Run, commit**

Run: `cd apps/web && bun run test:integration -- aws-connect && bun run typecheck` → PASS.

```bash
git add apps/web
git commit -m "feat(web): AWS connect service — keys/instance role, SES infra, production access"
```

---

### Task 8: CloudFormation template + callback + status endpoints

**Files:**

- Create: `infra/aws/sendsprite-connect.yaml`, `apps/web/src/app/api/setup/aws/callback/route.ts`, `apps/web/src/app/api/setup/aws/status/route.ts`
- Test: `apps/web/tests/integration/setup-callback.test.ts`
- Modify: `.github/workflows/ci.yml` (cfn-lint job); `services/aws-connect.ts` (subscribe failure → warning, not error); `services/setup-tokens.ts` + `db/schema/setup-tokens.ts` (`failed_at`/`failed_reason`, migration `0006`; `recordSetupFailure`, `lastSetupFailure`)

- [x] **Step 1: Template**

`infra/aws/sendsprite-connect.yaml`:

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: Sendsprite - least-privilege IAM user for Amazon SES + SNS events. An access key is created inside the stack's Lambda and posted once to your Sendsprite instance; it never enters CloudFormation state.
Parameters:
  # Must be https: an HTTP->HTTPS redirect would drop the POST body and the
  # callback would fail.
  CallbackUrl:
    Type: String
    Description: Your Sendsprite instance callback (prefilled, https).
    AllowedPattern: "^https://.+"
    ConstraintDescription: must be an https URL
  # Deliberately not NoEcho: CloudFormation quick-create links ignore NoEcho
  # parameters, so the wizard could not prefill it. The token is single-use and
  # expires in 15 minutes, which is the mitigation.
  CallbackToken:
    Type: String
    Description: One-time token (prefilled). Expires in 15 minutes.
Resources:
  SendspriteUser:
    Type: AWS::IAM::User
    Properties:
      UserName: !Sub "sendsprite-${AWS::StackName}"
      Policies:
        - PolicyName: sendsprite-ses
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              # SES identity ARNs are not known at stack time.
              - Effect: Allow
                Action:
                  - ses:GetAccount
                  - ses:PutAccountDetails
                  - ses:CreateEmailIdentity
                  - ses:DeleteEmailIdentity
                  - ses:GetEmailIdentity
                  - ses:PutEmailIdentityMailFromAttributes
                  - ses:CreateConfigurationSet
                  - ses:CreateConfigurationSetEventDestination
                  - ses:UpdateConfigurationSetEventDestination
                  - ses:SendEmail
                  - ses:SendRawEmail
                Resource: "*"
              # ConfirmSubscription: the webhook confirms through the SDK (with
              # AuthenticateOnUnsubscribe) instead of GET SubscribeURL.
              - Effect: Allow
                Action:
                  - sns:CreateTopic
                  - sns:Subscribe
                  - sns:ConfirmSubscription
                  - sns:GetTopicAttributes
                  - sns:SetTopicAttributes
                  - sns:ListSubscriptionsByTopic
                Resource: !Sub "arn:aws:sns:*:${AWS::AccountId}:sendsprite-*"
              # Subscription ARNs carry a UUID suffix; they are not topic-scoped.
              - Effect: Allow
                Action:
                  - sns:Unsubscribe
                  - sns:GetSubscriptionAttributes
                Resource: "*"
              - Effect: Allow
                Action: sts:GetCallerIdentity
                Resource: "*"
  CallbackFunctionRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal: { Service: lambda.amazonaws.com }
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
      Policies:
        - PolicyName: sendsprite-access-keys
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action:
                  - iam:CreateAccessKey
                  - iam:DeleteAccessKey
                  - iam:ListAccessKeys
                Resource: !GetAtt SendspriteUser.Arn
  # The Lambda creates the access key itself and POSTs it to Sendsprite, so the
  # secret never appears in CloudFormation resource properties, stack state or
  # events. It always answers the pre-signed ResponseURL (SUCCESS or FAILED);
  # a missing response would leave the stack hanging for an hour.
  #   Create: create key -> one POST to CallbackUrl -> on any failure delete
  #           the key it just created and report FAILED with the callback's
  #           response body as the reason. The POST is not retried: the
  #           callback token is single-use, and Sendsprite itself waits out
  #           IAM propagation of the new key (retrying its STS check for up
  #           to ~15 s, well inside the 45 s POST timeout below).
  #   Delete: remove every access key of the user so the user can be deleted.
  #   Update: no-op.
  CallbackFunction:
    Type: AWS::Lambda::Function
    Properties:
      Runtime: python3.12
      Handler: index.handler
      Timeout: 60
      Role: !GetAtt CallbackFunctionRole.Arn
      Code:
        ZipFile: |
          import json, urllib.request, urllib.error
          import boto3
          iam = boto3.client("iam")
          def respond(event, context, status, reason=""):
              body = json.dumps({"Status": status, "Reason": reason or "See CloudWatch logs",
                  "PhysicalResourceId": event.get("PhysicalResourceId") or context.log_stream_name,
                  "StackId": event["StackId"], "RequestId": event["RequestId"], "LogicalResourceId": event["LogicalResourceId"]}).encode()
              req = urllib.request.Request(event["ResponseURL"], data=body, method="PUT", headers={"content-type": ""})
              urllib.request.urlopen(req, timeout=10)
          def post(url, payload):
              req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST", headers={"content-type": "application/json"})
              try:
                  with urllib.request.urlopen(req, timeout=45) as r:
                      return r.status, ""
              except urllib.error.HTTPError as e:
                  return e.code, e.read()[:500].decode("utf-8", "replace")
          def create(p):
              key = iam.create_access_key(UserName=p["UserName"])["AccessKey"]
              try:
                  payload = {"token": p["CallbackToken"], "accessKeyId": key["AccessKeyId"], "secretAccessKey": key["SecretAccessKey"],
                      "region": p["Region"], "accountId": p["AccountId"]}
                  status, body = post(p["CallbackUrl"], payload)
                  if status >= 300:
                      raise Exception("callback returned %d: %s" % (status, body))
              except Exception:
                  iam.delete_access_key(UserName=p["UserName"], AccessKeyId=key["AccessKeyId"])
                  raise
          def delete(p):
              for k in iam.list_access_keys(UserName=p["UserName"])["AccessKeyMetadata"]:
                  iam.delete_access_key(UserName=p["UserName"], AccessKeyId=k["AccessKeyId"])
          def handler(event, context):
              try:
                  p = event["ResourceProperties"]
                  if event["RequestType"] == "Create":
                      create(p)
                  elif event["RequestType"] == "Delete":
                      delete(p)
                  respond(event, context, "SUCCESS")
              except Exception as e:
                  respond(event, context, "FAILED", str(e)[:1000])
  # Ordering after SendspriteUser is implied by the UserName Ref (an explicit
  # DependsOn trips cfn-lint W3005).
  Callback:
    Type: Custom::SendspriteCallback
    Properties:
      ServiceToken: !GetAtt CallbackFunction.Arn
      ServiceTimeout: 120
      CallbackUrl: !Ref CallbackUrl
      CallbackToken: !Ref CallbackToken
      UserName: !Ref SendspriteUser
      Region: !Ref AWS::Region
      AccountId: !Ref AWS::AccountId
Outputs:
  UserName:
    Value: !Ref SendspriteUser
  Note:
    Value: "Delete this stack to revoke Sendsprite's access."
```

Notes (applied in review):

- `NoEcho` parameters are ignored in quick-create URLs (AWS docs), so `CallbackToken` is not `NoEcho`; single-use + 15-minute expiry is the mitigation.
- No `AWS::IAM::AccessKey`: the Lambda creates the key itself (scoped `iam:CreateAccessKey/DeleteAccessKey/ListAccessKeys` on the user) so the secret never enters CloudFormation state; on failure it deletes the key; on `Delete` it removes all keys so the user can be deleted. It POSTs once (the token is single-use, so a Lambda-side retry could never succeed) and puts the callback's response body into the FAILED reason; IAM propagation of the new key is waited out server-side in `verifyIdentity` (6 attempts, 3 s apart, on `InvalidClientTokenId`/`InvalidSignatureException`/`AuthFailure`). The 502 body carries `code` (the AWS error name).
- `sns:Unsubscribe`/`GetSubscriptionAttributes` need `Resource: "*"` (subscription ARNs are not topic-scoped). Unused SES/SNS actions removed.
- `CallbackUrl` must be https (redirects drop POST bodies); Lambda `Timeout: 60`, `ServiceTimeout: 120`.

- [x] **Step 2: Validate the template**

Load the IaC MCP tool with ToolSearch `select:mcp__plugin_deploy-on-aws_awsiac__validate_cloudformation_template` and run it on the file (or `pip install cfn-lint && cfn-lint infra/aws/sendsprite-connect.yaml` if available). Expected: no errors (warnings about wildcard SES resources are acceptable — SES identity ARNs aren't known at stack time).

- [x] **Step 3: Failing integration test for the callback**

`apps/web/tests/integration/setup-callback.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SESv2Client,
  GetAccountCommand,
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
} from "@aws-sdk/client-sesv2";
import {
  SNSClient,
  CreateTopicCommand,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { user } from "@/db/schema";
import { startPg } from "./_pg";

const ses = mockClient(SESv2Client);
const sns = mockClient(SNSClient);
const sts = mockClient(STSClient);

const KEYS = {
  accessKeyId: "AKIAEXAMPLEEXAMPLE",
  secretAccessKey: "s3cr3ts3cr3ts3cr3ts3cr3t",
};

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
  await pg.db
    .insert(user)
    .values({ id: "u1", name: "One", email: "u1@example.com" });
});
afterAll(async () => {
  await pg.stop();
});
afterEach(() => {
  ses.reset();
  sns.reset();
  sts.reset();
});

function happyMocks() {
  sts.on(GetCallerIdentityCommand).resolves({
    Account: "123456789012",
    Arn: "arn:aws:iam::123456789012:user/sendsprite",
  });
  ses.on(GetAccountCommand).resolves({
    ProductionAccessEnabled: false,
    SendQuota: { Max24HourSend: 200, MaxSendRate: 1 },
  });
  ses.on(CreateConfigurationSetCommand).resolves({});
  ses.on(CreateConfigurationSetEventDestinationCommand).resolves({});
  sns.on(CreateTopicCommand).resolves({
    TopicArn: "arn:aws:sns:us-east-1:123456789012:sendsprite-events",
  });
  sns
    .on(SubscribeCommand)
    .resolves({ SubscriptionArn: "pending confirmation" });
}

async function issue(region: string) {
  const { issueSetupToken } = await import("@/services/setup-tokens");
  return (
    await issueSetupToken({
      purpose: "aws_callback",
      issuedBy: "u1",
      region,
      ttlMs: 60_000,
    })
  ).token;
}

const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/setup/aws/callback/route");
  return POST(
    new Request("https://mail.acme.com/api/setup/aws/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
};

describe("POST /api/setup/aws/callback", () => {
  it("consumes a valid token and connects; replay is refused without touching AWS", async () => {
    happyMocks();
    const token = await issue("us-east-1");
    const res = await post({
      token,
      ...KEYS,
      region: "us-east-1",
      accountId: "123456789012",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, warning: null });
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
    expect(await getInstanceSettings()).toMatchObject({
      awsMode: "keys",
      awsAccountId: "123456789012",
      awsRegion: "us-east-1",
    });
    expect((await post({ token, ...KEYS, region: "us-east-1" })).status).toBe(
      403,
    );
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(1);
  });

  it("rejects an unknown token with 403 and no AWS calls", async () => {
    happyMocks();
    const res = await post({
      token: "nope".repeat(12),
      ...KEYS,
      region: "us-east-1",
      accountId: "1",
    });
    expect(res.status).toBe(403);
    expect(ses.commandCalls(GetAccountCommand)).toHaveLength(0);
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0);
  });

  it("rejects a region mismatch and records the failure", async () => {
    happyMocks();
    const token = await issue("eu-west-1");
    const res = await post({ token, ...KEYS, region: "us-east-1" });
    expect(res.status).toBe(400);
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0);
    const { lastSetupFailure } = await import("@/services/setup-tokens");
    expect(await lastSetupFailure("aws_callback", "u1")).toMatchObject({
      at: expect.any(Date),
      reason: expect.stringContaining("eu-west-1"),
    });
  });

  it("rejects a malformed body, short keys and unsupported regions with 400", async () => {
    const { POST } = await import("@/app/api/setup/aws/callback/route");
    const raw = await POST(
      new Request("https://mail.acme.com/api/setup/aws/callback", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(raw.status).toBe(400);
    const token = await issue("us-east-1");
    expect(
      (await post({ token, ...KEYS, region: "mars-north-1" })).status,
    ).toBe(400);
    expect(
      (
        await post({
          token,
          ...KEYS,
          secretAccessKey: "short",
          region: "us-east-1",
        })
      ).status,
    ).toBe(400);
    // Validation happens before the token is touched, so it is still usable.
    happyMocks();
    expect((await post({ token, ...KEYS, region: "us-east-1" })).status).toBe(
      200,
    );
  });

  it("returns 502 with the error code and without the secret when AWS rejects the keys; token stays burned; failure is recorded", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .rejects(
        Object.assign(
          new Error("User is not authorized to perform sts:GetCallerIdentity"),
          { name: "AccessDenied" },
        ),
      );
    const token = await issue("us-east-1");
    const res = await post({ token, ...KEYS, region: "us-east-1" });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      error: expect.stringContaining("AWS rejected the connection"),
      code: "AccessDenied",
    });
    expect(text).not.toContain(KEYS.secretAccessKey);
    expect((await post({ token, ...KEYS, region: "us-east-1" })).status).toBe(
      403,
    );
    const { lastSetupFailure } = await import("@/services/setup-tokens");
    expect(await lastSetupFailure("aws_callback", "u1")).toMatchObject({
      reason: expect.stringContaining("not authorized"),
    });
  });

  it("returns 200 with a warning when only the SNS subscription fails", async () => {
    happyMocks();
    sns.on(SubscribeCommand).rejects(
      Object.assign(new Error("not authorized to perform: SNS:Subscribe"), {
        name: "AuthorizationError",
      }),
    );
    const token = await issue("us-east-1");
    const res = await post({ token, ...KEYS, region: "us-east-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      warning: expect.stringContaining("SES event subscription"),
    });
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
    expect(await getInstanceSettings()).toMatchObject({
      awsMode: "keys",
      snsSubscriptionArn: null,
    });
  });
});
```

Run → FAIL (route missing).

- [x] **Step 4: Routes**

`apps/web/src/app/api/setup/aws/callback/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { SES_REGIONS } from "@/lib/aws/regions";
import { consumeSetupToken, recordSetupFailure } from "@/services/setup-tokens";
import { connectWithKeys } from "@/services/aws-connect";

export const dynamic = "force-dynamic";
const body = z.object({
  token: z.string().min(40),
  accessKeyId: z.string().min(16).max(128),
  secretAccessKey: z.string().min(16).max(128),
  region: z.enum(SES_REGIONS),
  accountId: z.string().optional(),
});

/**
 * Called once by the CloudFormation custom resource. Auth = one-time token,
 * burned on first use even when the connection then fails (the wizard issues
 * a new one for a retry). A non-2xx makes the Lambda report FAILED, so the
 * stack rolls back and the IAM user is deleted; the failure reason is kept
 * on the token for /status. A subscribe-only problem is a 200 with a warning
 * so a working connection is never rolled back. A stack created while AWS
 * is already connected is refused with 409 (the live connection is never
 * replaced silently); the token is consumed all the same.
 */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const tok = await consumeSetupToken("aws_callback", parsed.data.token);
  if (!tok)
    return NextResponse.json({ error: "invalid_token" }, { status: 403 });
  if (tok.region !== parsed.data.region) {
    await recordSetupFailure(
      tok.id,
      `Stack was created in ${parsed.data.region} but ${tok.region} was selected.`,
    );
    return NextResponse.json({ error: "region_mismatch" }, { status: 400 });
  }
  const res = await connectWithKeys(
    {
      accessKeyId: parsed.data.accessKeyId,
      secretAccessKey: parsed.data.secretAccessKey,
      region: parsed.data.region,
    },
    { userId: tok.issuedBy },
  );
  if (!res.ok) {
    await recordSetupFailure(tok.id, res.error);
    return NextResponse.json(
      { error: res.error, code: res.code ?? null },
      { status: res.code === "ALREADY_CONNECTED" ? 409 : 502 },
    );
  }
  // Only the Lambda sees this response; keep a server-side trace of it.
  if (res.data.warning)
    console.warn(
      "setup/aws/callback: connected with warning:",
      res.data.warning,
    );
  return NextResponse.json({ ok: true, warning: res.data.warning ?? null });
}
```

`apps/web/src/app/api/setup/aws/status/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { resolveTeam } from "@/lib/team";
import { getInstanceSettings } from "@/services/instance-settings";
import { lastSetupFailure, pendingSetupToken } from "@/services/setup-tokens";

export const dynamic = "force-dynamic";

/**
 * Polled by the wizard while the user is in the AWS console. Account details
 * are owner-only; other members just learn whether the instance is connected.
 */
export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [settings, pending, team] = await Promise.all([
    getInstanceSettings(),
    pendingSetupToken("aws_callback", s.user.id),
    resolveTeam(s.user.id, s.session.activeOrganizationId ?? null),
  ]);
  const base = {
    connected: settings.awsMode !== "none",
    pendingToken: Boolean(pending),
    expiresAt: pending?.expiresAt ?? null,
  };
  if (team?.role !== "owner") return NextResponse.json(base);
  return NextResponse.json({
    ...base,
    awsMode: settings.awsMode,
    accountId: settings.awsAccountId,
    status: settings.sesAccountStatus,
    lastFailure: await lastSetupFailure("aws_callback", s.user.id),
  });
}
```

- [x] **Step 5: CI cfn-lint job**

Add to `.github/workflows/ci.yml`:

```yaml
cfn:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-python@v5
      with: { python-version: "3.12" }
    - run: pip install cfn-lint
    - run: cfn-lint infra/aws/sendsprite-connect.yaml
    # Publish on tags once the bucket exists (maintainer step, see Task 17):
    # - run: aws s3 cp infra/aws/sendsprite-connect.yaml s3://sendsprite-cfn/${GITHUB_REF_NAME}/sendsprite-connect.yaml --acl public-read
    # - run: aws s3 cp infra/aws/sendsprite-connect.yaml s3://sendsprite-cfn/latest/sendsprite-connect.yaml --acl public-read
```

- [x] **Step 6: Run, commit**

Run: `cd apps/web && bun run test:integration -- setup-callback && bun run typecheck` → PASS.

```bash
git add infra apps/web .github
git commit -m "feat: CloudFormation one-click connect template, callback and status endpoints"
```

---

### Task 9: SNS endpoint — signature verification, subscription confirmation

**Files:**

- Create: `apps/web/src/lib/sns-message.ts`, `apps/web/src/app/api/webhooks/ses/route.ts`
- Test: `apps/web/tests/unit/sns-message.test.ts`, `apps/web/tests/integration/ses-webhook.test.ts`
- Modify: `apps/web/package.json` (`sns-validator`)

- [x] **Step 1: Install and wrap the validator (failing unit test first)**

Run: `cd apps/web && bun add sns-validator && bun add -d @types/sns-validator` (if no types exist, add `apps/web/src/types/sns-validator.d.ts`: `declare module "sns-validator" { export default class MessageValidator { constructor(hostPattern?: RegExp, encoding?: string); validate(message: unknown, cb: (err: Error | null, message?: unknown) => void): void; } }`).

`tests/unit/sns-message.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { verifySnsMessage } from "@/lib/sns-message";

describe("verifySnsMessage", () => {
  it("rejects a message whose SigningCertURL is not on amazonaws.com", async () => {
    await expect(
      verifySnsMessage({
        Type: "Notification",
        MessageId: "1",
        TopicArn: "arn",
        Message: "{}",
        Timestamp: "2026-01-01T00:00:00Z",
        SignatureVersion: "1",
        Signature: "x",
        SigningCertURL: "https://evil.com/cert.pem",
      }),
    ).rejects.toThrow(/invalid domain/);
  });
  it("rejects a message with no signature fields", async () => {
    await expect(verifySnsMessage({ Type: "Notification" })).rejects.toThrow();
  });
});
```

`apps/web/src/lib/sns-message.ts`:

```ts
import MessageValidator from "sns-validator";

export type SnsMessage =
  | {
      Type: "SubscriptionConfirmation";
      TopicArn: string;
      Token: string;
      SubscribeURL: string;
      MessageId: string;
    }
  | {
      Type: "Notification";
      TopicArn: string;
      Message: string;
      MessageId: string;
      Timestamp: string;
    }
  | { Type: "UnsubscribeConfirmation"; TopicArn: string; MessageId: string };

const validator = new MessageValidator(
  /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/,
);

/**
 * Verifies the SNS signature (cert fetched from amazonaws.com only). Throws
 * on failure. This wrapper is the seam for replacing `sns-validator`
 * (unmaintained, CommonJS, callback API): callers and tests depend only on
 * this function and the `SnsMessage` type.
 */
export function verifySnsMessage(raw: unknown): Promise<SnsMessage> {
  return new Promise((resolve, reject) => {
    validator.validate(raw, (err, msg) =>
      err ? reject(err) : resolve(msg as SnsMessage),
    );
  });
}
```

Run `bun run test` → PASS. (Signature verification with real certs is exercised in Phase 3 against recorded SNS payloads; here we test the guardrails.)

- [x] **Step 2: Failing integration test for the route (validator injected, SNS client mocked)**

The SDK path is preferred: `ConfirmSubscriptionCommand` returns a typed ARN (no XML) and `AuthenticateOnUnsubscribe: "true"` makes unsubscribing require a signed request. The `SubscribeURL` GET is only the fallback when AWS is not connected. The body is capped at 512 KiB; `UnsubscribeConfirmation` clears the stored ARN.

`tests/integration/ses-webhook.test.ts`:

```ts
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ConfirmSubscriptionCommand, SNSClient } from "@aws-sdk/client-sns";
import { startPg } from "./_pg";

vi.mock("@/lib/sns-message", () => ({
  verifySnsMessage: async (raw: unknown) => raw,
}));

const TOPIC = "arn:aws:sns:us-east-1:1:sendsprite-events";
const SUB = `${TOPIC}:sub-1`;
const sns = mockClient(SNSClient);

let pg: Awaited<ReturnType<typeof startPg>>;
let fetchCalls: { url: string; init?: RequestInit }[] = [];
let fetchBody = "";
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(fetchBody, { status: 200 });
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pg.stop();
});
beforeEach(() => {
  sns.reset();
  fetchCalls = [];
  fetchBody = `<ConfirmSubscriptionResponse><ConfirmSubscriptionResult><SubscriptionArn>${SUB}</SubscriptionArn></ConfirmSubscriptionResult></ConfirmSubscriptionResponse>`;
});

const settings = () => import("@/services/instance-settings");
const route = () => import("@/app/api/webhooks/ses/route");
const post = async (body: { Type: string } & Record<string, unknown>) => {
  const { POST } = await route();
  return POST(
    new Request("https://mail.acme.com/api/webhooks/ses", {
      method: "POST",
      headers: {
        "x-amz-sns-message-type": body.Type,
        "content-type": "text/plain",
      },
      body: JSON.stringify(body),
    }),
  );
};
const confirmation = (over: Record<string, unknown> = {}) => ({
  Type: "SubscriptionConfirmation",
  TopicArn: TOPIC,
  Token: "t",
  SubscribeURL:
    "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t",
  MessageId: "m1",
  ...over,
});

// Ordered: connected (SDK path) first, then disconnected (fallback path).
describe("POST /api/webhooks/ses", () => {
  it("confirms via the SDK with AuthenticateOnUnsubscribe when AWS is connected", async () => {
    const { updateInstanceSettings, getInstanceSettings } = await settings();
    await updateInstanceSettings({
      awsMode: "keys",
      awsRegion: "us-east-1",
      awsAccessKey: "AKIAEXAMPLEEXAMPLE",
      awsSecret: "s3cr3ts3cr3ts3cr3ts3cr3t",
      snsTopicArn: TOPIC,
    });
    sns.on(ConfirmSubscriptionCommand).resolves({ SubscriptionArn: SUB });
    const res = await post(confirmation());
    expect(res.status).toBe(200);
    expect(
      sns.commandCalls(ConfirmSubscriptionCommand)[0]!.args[0].input,
    ).toEqual({
      TopicArn: TOPIC,
      Token: "t",
      AuthenticateOnUnsubscribe: "true",
    });
    expect(fetchCalls).toHaveLength(0);
    expect((await getInstanceSettings()).snsSubscriptionArn).toBe(SUB);
  });

  it("does not overwrite the stored ARN when SNS returns none", async () => {
    const { getInstanceSettings } = await settings();
    sns.on(ConfirmSubscriptionCommand).resolves({});
    const res = await post(confirmation({ MessageId: "m1b" }));
    expect(res.status).toBe(200);
    expect((await getInstanceSettings()).snsSubscriptionArn).toBe(SUB);
  });

  it("clears the ARN on UnsubscribeConfirmation", async () => {
    const { getInstanceSettings } = await settings();
    const res = await post({
      Type: "UnsubscribeConfirmation",
      TopicArn: TOPIC,
      MessageId: "m4",
    });
    expect(res.status).toBe(200);
    expect((await getInstanceSettings()).snsSubscriptionArn).toBeNull();
  });

  it("falls back to fetching SubscribeURL with a timeout when AWS is not connected", async () => {
    const { updateInstanceSettings, getInstanceSettings } = await settings();
    await updateInstanceSettings({
      awsMode: "none",
      awsAccessKey: null,
      awsSecret: null,
    });
    const res = await post(confirmation({ MessageId: "m5" }));
    expect(res.status).toBe(200);
    expect(sns.calls()).toHaveLength(0);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain("ConfirmSubscription");
    expect(fetchCalls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect((await getInstanceSettings()).snsSubscriptionArn).toBe(SUB);
  });

  it("keeps the stored ARN when the fallback response has no SubscriptionArn", async () => {
    const { getInstanceSettings } = await settings();
    fetchBody = "<ConfirmSubscriptionResponse/>";
    const res = await post(confirmation({ MessageId: "m6" }));
    expect(res.status).toBe(200);
    expect((await getInstanceSettings()).snsSubscriptionArn).toBe(SUB);
  });

  it("rejects a look-alike SubscribeURL host without fetching", async () => {
    const res = await post(
      confirmation({
        SubscribeURL: "https://sns.us-east-1.amazonaws.com.evil.com/?x",
        MessageId: "m7",
      }),
    );
    expect(res.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });

  it("ignores confirmations for a foreign topic", async () => {
    const res = await post(
      confirmation({
        TopicArn: "arn:aws:sns:us-east-1:999:other",
        MessageId: "m2",
      }),
    );
    expect(res.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
    expect(sns.calls()).toHaveLength(0);
  });

  it("rejects oversized bodies with 413", async () => {
    const { POST } = await route();
    const big = "x".repeat(524_289);
    const declared = await POST(
      new Request("https://mail.acme.com/api/webhooks/ses", {
        method: "POST",
        headers: { "content-length": String(big.length) },
        body: "{}",
      }),
    );
    expect(declared.status).toBe(413);
    const actual = await POST(
      new Request("https://mail.acme.com/api/webhooks/ses", {
        method: "POST",
        body: big,
      }),
    );
    expect(actual.status).toBe(413);
  });

  it("acknowledges notifications (processing lands in Phase 3)", async () => {
    const res = await post({
      Type: "Notification",
      TopicArn: TOPIC,
      Message: JSON.stringify({ eventType: "Send" }),
      MessageId: "m3",
      Timestamp: "2026-08-25T00:00:00Z",
    });
    expect(res.status).toBe(200);
  });
});
```

- [x] **Step 3: Route**

`apps/web/src/app/api/webhooks/ses/route.ts`:

```ts
import { NextResponse } from "next/server";
import { ConfirmSubscriptionCommand } from "@aws-sdk/client-sns";
import { makeSns } from "@/lib/aws/clients";
import { resolveAwsContext } from "@/lib/aws/credentials";
import { verifySnsMessage } from "@/lib/sns-message";
import {
  getInstanceSettings,
  updateInstanceSettings,
} from "@/services/instance-settings";

export const dynamic = "force-dynamic";

/** SNS messages are a few KB; anything near this is not SNS. */
const MAX_BODY_BYTES = 524_288;
const SUBSCRIBE_URL = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\//;
const isArn = (v: string | undefined): v is string => !!v?.startsWith("arn:");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Confirm = { arn: string | null } | { error: string; status: number };

/**
 * Confirm via the SDK when AWS is connected: the response is a typed ARN (no
 * XML scraping) and `AuthenticateOnUnsubscribe` makes SNS require a signed
 * request to unsubscribe, so a leaked SubscribeURL/Token cannot be replayed
 * to drop the subscription. When there are no credentials to sign with, or
 * the SDK call fails (a policy without `sns:ConfirmSubscription`, a stale
 * key…), it falls back to GET SubscribeURL (the unauthenticated confirm SNS
 * documents), host-guarded, redirect-free and time-limited: a subscription
 * that never confirms is worse than one without the unsubscribe guard.
 */
async function confirmSubscription(msg: {
  TopicArn: string;
  Token: string;
  SubscribeURL: string;
}): Promise<Confirm> {
  const ctx = await resolveAwsContext().catch(() => null);
  if (ctx) {
    try {
      const r = await makeSns(ctx).send(
        new ConfirmSubscriptionCommand({
          TopicArn: msg.TopicArn,
          Token: msg.Token,
          AuthenticateOnUnsubscribe: "true",
        }),
      );
      return { arn: isArn(r.SubscriptionArn) ? r.SubscriptionArn : null };
    } catch (e) {
      console.warn(
        "[ses] ConfirmSubscription via the SDK failed; falling back to SubscribeURL:",
        errMsg(e),
      );
    }
  }
  if (!SUBSCRIBE_URL.test(msg.SubscribeURL))
    return { error: "bad_subscribe_url", status: 400 };
  const r = await fetch(msg.SubscribeURL, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) return { error: "confirm_failed", status: 502 };
  const arn = /<SubscriptionArn>([^<]+)<\/SubscriptionArn>/.exec(
    await r.text(),
  )?.[1];
  return { arn: isArn(arn) ? arn : null };
}

/**
 * SNS → Sendsprite. Phase 2: verify signature, confirm subscription, ack.
 * Phase 3 replaces the Notification branch with event ingestion.
 */
export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES)
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES)
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  let msg;
  try {
    msg = await verifySnsMessage(raw);
  } catch {
    return NextResponse.json({ error: "bad_signature" }, { status: 403 });
  }
  const settings = await getInstanceSettings();
  if (!settings.snsTopicArn || msg.TopicArn !== settings.snsTopicArn)
    return NextResponse.json({ error: "unknown_topic" }, { status: 403 });

  if (msg.Type === "SubscriptionConfirmation") {
    const r = await confirmSubscription(msg);
    if ("error" in r)
      return NextResponse.json({ error: r.error }, { status: r.status });
    // Never replace a real ARN with a sentinel; a later reconnect fills it in.
    if (r.arn)
      await updateInstanceSettings({ snsSubscriptionArn: r.arn }, undefined, {
        audit: false,
      });
    else console.warn("[ses] subscription confirmed but no ARN was returned");
    return NextResponse.json({ ok: true });
  }
  if (msg.Type === "UnsubscribeConfirmation") {
    await updateInstanceSettings({ snsSubscriptionArn: null }, undefined, {
      audit: false,
    });
    return NextResponse.json({ ok: true });
  }
  console.info("[ses] notification", msg.MessageId); // Phase 3: enqueue ses.ingest
  return NextResponse.json({ ok: true });
}
```

- [x] **Step 4: Run, commit**

Run: `cd apps/web && bun run test && bun run test:integration -- ses-webhook && bun run typecheck` → PASS.

```bash
git add apps/web
git commit -m "feat(web): SNS endpoint with signature verification and subscription confirmation"
```

---

### Task 10: Hourly SES account refresh job

**Files:**

- Create: `apps/web/src/jobs/handlers/ses-refresh-account.ts`
- Modify: `apps/web/src/jobs/handlers/index.ts`, `apps/web/src/jobs/queues.ts`
- Test: `apps/web/tests/integration/worker.test.ts` (registration smoke)

- [x] **Step 1: Queue name + handler**

`queues.ts`: add `sesRefreshAccount: "ses.refresh-account"`, `domainProvision: "domain.provision"`, `domainVerify: "domain.verify"`.

`handlers/ses-refresh-account.ts`:

```ts
import { registerQueue } from "../boss";
import { Q } from "../queues";
import { getInstanceSettings } from "@/services/instance-settings";
import { refreshSesAccount } from "@/services/aws-connect";

registerQueue(
  Q.sesRefreshAccount,
  async () => {
    const s = await getInstanceSettings();
    if (s.awsMode === "none") return;
    const r = await refreshSesAccount();
    if (!r.ok) console.warn("[ses] account refresh failed:", r.error);
  },
  { cron: "17 * * * *", queue: { retryLimit: 0 } },
);
```

`handlers/index.ts`: `import "./ses-refresh-account";`

- [x] **Step 2: Test — queue is registered on start**

Append to `worker.test.ts`: after `startWorker()`, `expect(await (await getBoss()).getQueue("ses.refresh-account")).toBeTruthy()`.

- [x] **Step 3: Run, commit**

`cd apps/web && bun run test:integration -- worker` → PASS. `git add apps/web && git commit -m "feat(web): hourly SES account status refresh job"`

---

### Task 11: Cloudflare client + connect service (TDD, fetch-injected)

**Files:**

- Create: `apps/web/src/lib/cloudflare/client.ts`, `apps/web/src/services/cloudflare-connect.ts`
- Test: `apps/web/tests/unit/cloudflare-client.test.ts`, `apps/web/tests/integration/cloudflare-connect.test.ts`

- [x] **Step 1: Failing unit test**

`tests/unit/cloudflare-client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CloudflareClient } from "@/lib/cloudflare/client";

function fake(routes: Record<string, (init?: RequestInit) => unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key)
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 404, message: "no route" }],
        }),
        { status: 404 },
      );
    return new Response(
      JSON.stringify({ success: true, result: routes[key]!(init) }),
      { status: 200 },
    );
  };
  return { fetch: f as typeof fetch, calls };
}

describe("CloudflareClient", () => {
  it("verifies token and lists zones", async () => {
    const { fetch, calls } = fake({
      "/user/tokens/verify": () => ({ status: "active" }),
      "/zones": () => [{ id: "z1", name: "acme.com" }],
    });
    const cf = new CloudflareClient("tok", fetch);
    expect(await cf.verifyToken()).toEqual({ status: "active" });
    expect(await cf.listZones()).toEqual([{ id: "z1", name: "acme.com" }]);
    expect(calls[0]!.init?.headers).toMatchObject({
      authorization: "Bearer tok",
    });
  });
  it("upserts by name+type: creates when absent, updates when present", async () => {
    const { fetch, calls } = fake({
      "/zones/z1/dns_records?": () => [
        { id: "r1", type: "TXT", name: "_dmarc.acme.com", content: "old" },
      ],
      "/zones/z1/dns_records/r1": () => ({ id: "r1" }),
      "/zones/z1/dns_records": () => ({ id: "r2" }),
    });
    const cf = new CloudflareClient("tok", fetch);
    expect(
      await cf.upsertRecord("z1", {
        type: "TXT",
        name: "_dmarc.acme.com",
        content: "new",
      }),
    ).toEqual({ id: "r1" });
    expect(
      calls.some(
        (c) => c.url.endsWith("/dns_records/r1") && c.init?.method === "PATCH",
      ),
    ).toBe(true);
    expect(
      await cf.upsertRecord("z1", {
        type: "CNAME",
        name: "x._domainkey.acme.com",
        content: "y",
      }),
    ).toEqual({ id: "r2" });
  });
  it("surfaces Cloudflare error messages", async () => {
    const f = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        }),
        { status: 403 },
      )) as typeof fetch;
    await expect(new CloudflareClient("bad", f).verifyToken()).rejects.toThrow(
      /Authentication error/,
    );
  });
});
```

- [x] **Step 2: Client**

`apps/web/src/lib/cloudflare/client.ts`:

```ts
export interface CfZone {
  id: string;
  name: string;
}
export interface CfRecordInput {
  type: "CNAME" | "MX" | "TXT";
  name: string;
  content: string;
  priority?: number;
  ttl?: number;
  proxied?: boolean;
}
export interface CfRecord extends CfRecordInput {
  id: string;
}

export class CloudflareError extends Error {
  constructor(
    msg: string,
    readonly code?: number,
  ) {
    super(msg);
  }
}

/** Minimal Cloudflare v4 client. `fetch` is injectable for tests. */
export class CloudflareClient {
  constructor(
    private token: string,
    private f: typeof fetch = fetch,
    private base = "https://api.cloudflare.com/client/v4",
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.f(`${this.base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: T;
      errors?: { code: number; message: string }[];
    };
    if (!res.ok || body.success === false) {
      const e = body.errors?.[0];
      throw new CloudflareError(
        e?.message ?? `Cloudflare ${res.status}`,
        e?.code,
      );
    }
    return body.result as T;
  }

  verifyToken() {
    return this.call<{ status: string }>("/user/tokens/verify");
  }
  listZones() {
    return this.call<CfZone[]>("/zones?per_page=100&status=active");
  }
  listRecords(zoneId: string, q: { type?: string; name?: string } = {}) {
    const p = new URLSearchParams({
      per_page: "100",
      ...(q.type && { type: q.type }),
      ...(q.name && { name: q.name }),
    });
    return this.call<CfRecord[]>(`/zones/${zoneId}/dns_records?${p}`);
  }
  async upsertRecord(
    zoneId: string,
    r: CfRecordInput,
  ): Promise<{ id: string }> {
    const body = { ttl: 1, proxied: false, ...r };
    const existing = await this.listRecords(zoneId, {
      type: r.type,
      name: r.name,
    });
    const match = existing.find(
      (e) =>
        e.type === r.type &&
        e.name === r.name &&
        (r.type !== "TXT" || e.content === r.content || existing.length === 1),
    );
    if (match)
      return this.call(`/zones/${zoneId}/dns_records/${match.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    return this.call(`/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  deleteRecord(zoneId: string, id: string) {
    return this.call<{ id: string }>(`/zones/${zoneId}/dns_records/${id}`, {
      method: "DELETE",
    });
  }
}
```

Run `cd apps/web && bun run test` → PASS.

- [x] **Step 3: Connect service + integration test**

`tests/integration/cloudflare-connect.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
});
afterAll(async () => {
  await pg.stop();
});

const okFetch = (async (url: string) => {
  if (String(url).includes("/user/tokens/verify"))
    return new Response(
      JSON.stringify({ success: true, result: { status: "active" } }),
    );
  if (String(url).includes("/zones"))
    return new Response(
      JSON.stringify({
        success: true,
        result: [{ id: "z1", name: "acme.com" }],
      }),
    );
  return new Response("{}", { status: 404 });
}) as typeof fetch;

describe("connectCloudflare", () => {
  it("validates the token, stores it encrypted and lists zones", async () => {
    const { connectCloudflare, listZones } =
      await import("@/services/cloudflare-connect");
    const res = await connectCloudflare(
      "cf-token-value-0123456789",
      { userId: "u1" },
      okFetch,
    );
    expect(res).toMatchObject({
      ok: true,
      data: { zones: [{ id: "z1", name: "acme.com" }] },
    });
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
    expect((await getInstanceSettings()).cloudflareTokenEnc).toMatch(/^v1\./);
    expect(await listZones(okFetch)).toEqual([{ id: "z1", name: "acme.com" }]);
  });
  it("returns an error for an invalid token and stores nothing", async () => {
    const { connectCloudflare } = await import("@/services/cloudflare-connect");
    const bad = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 1000, message: "Invalid API Token" }],
        }),
        { status: 401 },
      )) as typeof fetch;
    const res = await connectCloudflare("bad", { userId: "u1" }, bad);
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Invalid API Token/),
    });
  });
});
```

`apps/web/src/services/cloudflare-connect.ts`:

```ts
import { CloudflareClient, type CfZone } from "@/lib/cloudflare/client";
import type { Result } from "@/lib/result";
import {
  getDecryptedSecrets,
  updateInstanceSettings,
} from "./instance-settings";
import type { Actor } from "./aws-connect";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function connectCloudflare(
  token: string,
  actor: Actor,
  f: typeof fetch = fetch,
): Promise<Result<{ zones: CfZone[] }>> {
  if (typeof token !== "string" || token.trim().length < 10)
    return { ok: false, error: "Paste the API token Cloudflare showed you." };
  const cf = new CloudflareClient(token.trim(), f);
  try {
    const v = await cf.verifyToken();
    if (v.status !== "active")
      return { ok: false, error: `Token status is ${v.status}.` };
    const zones = await cf.listZones();
    await updateInstanceSettings(
      {
        cloudflareToken: token.trim(),
        cloudflareConnectedAt: new Date(),
        cloudflareAccountName: zones[0]?.name ?? null,
      },
      actor,
    );
    return { ok: true, data: { zones } };
  } catch (e) {
    return { ok: false, error: `Cloudflare rejected the token: ${errMsg(e)}` };
  }
}

export async function disconnectCloudflare(actor: Actor): Promise<Result> {
  await updateInstanceSettings(
    {
      cloudflareToken: null,
      cloudflareConnectedAt: null,
      cloudflareAccountName: null,
    },
    actor,
  );
  return { ok: true, data: undefined };
}

/** Client bound to the stored token, or null when Cloudflare isn't connected. */
export async function cloudflareClient(
  f: typeof fetch = fetch,
): Promise<CloudflareClient | null> {
  const { cloudflareToken } = await getDecryptedSecrets();
  return cloudflareToken ? new CloudflareClient(cloudflareToken, f) : null;
}

export async function listZones(f: typeof fetch = fetch): Promise<CfZone[]> {
  const cf = await cloudflareClient(f);
  return cf ? cf.listZones() : [];
}
```

- [x] **Step 4: Run, commit**

Run → PASS. `git add apps/web && git commit -m "feat(web): Cloudflare client and connect service"`

---

**Review follow-ups (applied after the Task 11 commit):**

- Injected fetch is typed `FetchLike = (url, init?) => Promise<Response>` (not `typeof fetch`, which carries React's `preconnect` and rejects plain test fakes).
- `upsertRecord` TXT keying via `txtKey`: content normalised (one pair of surrounding quotes stripped, whitespace collapsed, trimmed); `v=spf1` / `v=DMARC1` prefixes key by prefix (RFC 7208 / RFC 7489 allow one per name, so an existing one is PATCHed); any other TXT keys by exact normalised content (created alongside neighbours). CNAME/MX still key by (type, name).
- `deleteRecord` is idempotent: HTTP 404 or Cloudflare code 81044 (incl. non-JSON 404 bodies) returns `{ id }`.
- `listZones` pages through `result_info.total_pages` (per_page 100). `CloudflareError` carries `code` and HTTP `status`.
- `connectCloudflare`: `cloudflareAccountName` is the zone name only when exactly one zone is visible (else `null`); zero zones succeeds with `data.warning` asking for Zone:Read; `CloudflareError` → "Cloudflare rejected the token: …" (with `code`), anything else → "Could not reach Cloudflare: …".

### Task 12: DNS pure helpers — expected records, zone matching, checks (TDD)

**Files:**

- Create: `apps/web/src/lib/dns/records.ts`, `apps/web/src/lib/dns/zone-match.ts`, `apps/web/src/lib/dns/check.ts`
- Test: `apps/web/tests/unit/dns-records.test.ts`, `apps/web/tests/unit/zone-match.test.ts`, `apps/web/tests/unit/dns-check.test.ts`

- [x] **Step 1: Failing tests**

`tests/unit/dns-records.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expectedRecords } from "@/lib/dns/records";

describe("expectedRecords", () => {
  const recs = expectedRecords({
    domain: "mail.acme.com",
    region: "eu-west-1",
    dkimTokens: ["a1", "b2", "c3"],
    mailFromDomain: "bounce.mail.acme.com",
  });
  it("emits 3 DKIM CNAMEs, MAIL FROM MX + SPF, and DMARC", () => {
    expect(recs.map((r) => r.kind)).toEqual([
      "DKIM",
      "DKIM",
      "DKIM",
      "MAIL_FROM_MX",
      "MAIL_FROM_SPF",
      "DMARC",
    ]);
    expect(recs[0]).toMatchObject({
      type: "CNAME",
      name: "a1._domainkey.mail.acme.com",
      value: "a1.dkim.amazonses.com",
      ok: false,
    });
    expect(recs[3]).toMatchObject({
      type: "MX",
      name: "bounce.mail.acme.com",
      value: "feedback-smtp.eu-west-1.amazonses.com",
      priority: 10,
    });
    expect(recs[4]).toMatchObject({
      type: "TXT",
      name: "bounce.mail.acme.com",
      value: "v=spf1 include:amazonses.com ~all",
    });
    expect(recs[5]).toMatchObject({
      type: "TXT",
      name: "_dmarc.mail.acme.com",
      value: "v=DMARC1; p=none; rua=mailto:dmarc@mail.acme.com",
    });
  });
});
```

`tests/unit/zone-match.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchZone } from "@/lib/dns/zone-match";
const zones = [
  { id: "z1", name: "acme.com" },
  { id: "z2", name: "mail.acme.com" },
  { id: "z3", name: "other.io" },
];
describe("matchZone", () => {
  it("picks the longest suffix zone", () => {
    expect(matchZone("x.mail.acme.com", zones)?.id).toBe("z2");
    expect(matchZone("acme.com", zones)?.id).toBe("z1");
  });
  it("returns null when no zone matches", () => {
    expect(matchZone("acme.com.evil.net", zones)).toBeNull();
    expect(matchZone("notacme.com", zones)).toBeNull();
  });
});
```

`tests/unit/dns-check.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkRecords, type Resolver } from "@/lib/dns/check";
import { expectedRecords } from "@/lib/dns/records";

const resolver: Resolver = {
  resolveCname: async (n) =>
    n.startsWith("a1._domainkey") ? ["a1.dkim.amazonses.com"] : [],
  resolveMx: async (n) =>
    n === "bounce.mail.acme.com"
      ? [{ exchange: "feedback-smtp.eu-west-1.amazonses.com", priority: 10 }]
      : [],
  resolveTxt: async (n) =>
    n === "_dmarc.mail.acme.com"
      ? [["v=DMARC1; p=none; rua=mailto:dmarc@mail.acme.com"]]
      : n === "bounce.mail.acme.com"
        ? [["v=spf1 ", "include:amazonses.com ~all"]]
        : [],
};

describe("checkRecords", () => {
  it("marks each expected record ok/not-ok from live DNS", async () => {
    const recs = expectedRecords({
      domain: "mail.acme.com",
      region: "eu-west-1",
      dkimTokens: ["a1", "b2", "c3"],
      mailFromDomain: "bounce.mail.acme.com",
    });
    const out = await checkRecords(recs, resolver);
    expect(out.map((r) => r.ok)).toEqual([
      true,
      false,
      false,
      true,
      true,
      true,
    ]);
  });
  it("treats resolver errors (NXDOMAIN) as not-ok", async () => {
    const throwing: Resolver = {
      resolveCname: async () => {
        throw Object.assign(new Error("x"), { code: "ENOTFOUND" });
      },
      resolveMx: async () => {
        throw new Error("x");
      },
      resolveTxt: async () => {
        throw new Error("x");
      },
    };
    const out = await checkRecords(
      expectedRecords({
        domain: "a.com",
        region: "us-east-1",
        dkimTokens: ["t"],
        mailFromDomain: "b.a.com",
      }),
      throwing,
    );
    expect(out.every((r) => r.ok === false)).toBe(true);
  });
});
```

Run: `cd apps/web && bun run test` → FAIL.

- [x] **Step 2: Implement**

`apps/web/src/lib/dns/records.ts`:

```ts
import type { ExpectedRecord } from "@/db/schema/domains";

export interface RecordInput {
  domain: string;
  region: string;
  dkimTokens: string[];
  mailFromDomain: string;
  dmarcPolicy?: "none" | "quarantine" | "reject";
}

/** The DNS every SES domain needs. Pure; order is stable for display. */
export function expectedRecords(i: RecordInput): ExpectedRecord[] {
  const dkim: ExpectedRecord[] = i.dkimTokens.map((t) => ({
    kind: "DKIM",
    type: "CNAME",
    name: `${t}._domainkey.${i.domain}`,
    value: `${t}.dkim.amazonses.com`,
    ok: false,
  }));
  return [
    ...dkim,
    {
      kind: "MAIL_FROM_MX",
      type: "MX",
      name: i.mailFromDomain,
      value: `feedback-smtp.${i.region}.amazonses.com`,
      priority: 10,
      ok: false,
    },
    {
      kind: "MAIL_FROM_SPF",
      type: "TXT",
      name: i.mailFromDomain,
      value: "v=spf1 include:amazonses.com ~all",
      ok: false,
    },
    {
      kind: "DMARC",
      type: "TXT",
      name: `_dmarc.${i.domain}`,
      value: `v=DMARC1; p=${i.dmarcPolicy ?? "none"}; rua=mailto:dmarc@${i.domain}`,
      ok: false,
    },
  ];
}
```

`apps/web/src/lib/dns/zone-match.ts`:

```ts
export function matchZone<Z extends { name: string }>(
  domain: string,
  zones: Z[],
): Z | null {
  const d = domain.toLowerCase();
  let best: Z | null = null;
  for (const z of zones) {
    const n = z.name.toLowerCase();
    if (
      (d === n || d.endsWith(`.${n}`)) &&
      (!best || n.length > best.name.length)
    )
      best = z;
  }
  return best;
}
```

`apps/web/src/lib/dns/check.ts`:

```ts
import { promises as dns } from "node:dns";
import type { ExpectedRecord } from "@/db/schema/domains";

export interface Resolver {
  resolveCname(name: string): Promise<string[]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolveTxt(name: string): Promise<string[][]>;
}
/** Public resolvers so we see what the world sees, not the host's split-horizon view. */
export function publicResolver(): Resolver {
  const r = new dns.Resolver();
  r.setServers(["1.1.1.1", "8.8.8.8"]);
  return {
    resolveCname: (n) => r.resolveCname(n),
    resolveMx: (n) => r.resolveMx(n),
    resolveTxt: (n) => r.resolveTxt(n),
  };
}
const norm = (s: string) => s.toLowerCase().replace(/\.$/, "");

async function ok(rec: ExpectedRecord, res: Resolver): Promise<boolean> {
  try {
    if (rec.type === "CNAME")
      return (await res.resolveCname(rec.name)).some(
        (v) => norm(v) === norm(rec.value),
      );
    if (rec.type === "MX")
      return (await res.resolveMx(rec.name)).some(
        (m) => norm(m.exchange) === norm(rec.value),
      );
    return (await res.resolveTxt(rec.name)).some(
      (chunks) => chunks.join("").replace(/\s+/g, " ").trim() === rec.value,
    );
  } catch {
    return false;
  }
}

export async function checkRecords(
  recs: ExpectedRecord[],
  res: Resolver = publicResolver(),
): Promise<ExpectedRecord[]> {
  return Promise.all(recs.map(async (r) => ({ ...r, ok: await ok(r, res) })));
}
```

Run → PASS. Commit: `git add apps/web && git commit -m "feat(web): DNS expected records, zone matching, live checks"`

---

**Review follow-ups (applied after the Task 12 commit):**

- `RecordInput.dmarcRua?: string | null`; omitted → `v=DMARC1; p=none` (no `rua=` tag).
- `matchZone` and `createDomain` strip a trailing dot from the domain.
- `publicResolver()` uses `new dns.Resolver({ timeout: 3000, tries: 2 })`; JSDoc notes the outbound port-53 requirement and the CNAME-flattening caveat.
- `checkRecords` is kind-aware: `MAIL_FROM_SPF` ok = a `v=spf1` TXT at the name containing `include:amazonses.com`; `DMARC` ok = any `v=DMARC1` TXT at `_dmarc.<domain>`; CNAME/MX compare lowercased, trailing dot stripped, MX exchange only. TXT normalisation is shared with the Cloudflare client (`normaliseTxt`).

### Task 13: Domains service + jobs (TDD with mocks)

**Files:**

- Create: `apps/web/src/services/domains.ts`, `apps/web/src/jobs/enqueue.ts`, `apps/web/src/jobs/handlers/domain-provision.ts`, `apps/web/src/jobs/handlers/domain-verify.ts`
- Modify: `apps/web/src/jobs/handlers/index.ts`, `apps/web/src/jobs/boss.ts` (`QueueOptions.policy`)
- Test: `apps/web/tests/integration/domains.test.ts`

- [x] **Step 1: Failing test**

```ts
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SESv2Client,
  CreateEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  GetEmailIdentityCommand,
  DeleteEmailIdentityCommand,
} from "@aws-sdk/client-sesv2";
import { and, eq } from "drizzle-orm";
import type { FetchLike } from "@/lib/cloudflare/client";
import type { Resolver } from "@/lib/dns/check";
import { auditLog, domains } from "@/db/schema";
import { startPg } from "./_pg";

const ses = mockClient(SESv2Client);
let pg: Awaited<ReturnType<typeof startPg>>;
const cfCalls: { url: string; method?: string }[] = [];
const ok = (result: unknown) =>
  new Response(JSON.stringify({ success: true, result }));
/** Empty zone: every upsert creates (POST), every delete succeeds. */
const cfFetch: FetchLike = async (url, init) => {
  cfCalls.push({ url: String(url), method: init?.method });
  if (url.includes("/user/tokens/verify")) return ok({ status: "active" });
  if (/\/zones\?/.test(url)) return ok([{ id: "z1", name: "acme.com" }]);
  if (url.includes("/dns_records?")) return ok([]);
  if (url.includes("/dns_records")) return ok({ id: `r${cfCalls.length}` });
  return new Response("{}", { status: 404 });
};
/** Zone that already holds every record: upserts PATCH the existing ids. */
const cfExisting: FetchLike = async (url, init) => {
  cfCalls.push({ url: String(url), method: init?.method });
  const u = new URL(url);
  if (u.pathname.endsWith("/dns_records") && init?.method === undefined) {
    const type = u.searchParams.get("type")!;
    const name = u.searchParams.get("name")!;
    const content =
      type !== "TXT"
        ? "old"
        : name.startsWith("_dmarc")
          ? "v=DMARC1; p=reject"
          : "v=spf1 -all";
    return ok([{ id: `e-${type}-${name}`, type, name, content }]);
  }
  if (init?.method === "PATCH") return ok({ id: u.pathname.split("/").pop() });
  return cfFetch(url, init);
};
/** Cloudflare refuses every DELETE. */
const cfNoDelete: FetchLike = async (url, init) =>
  init?.method === "DELETE"
    ? new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        }),
        { status: 403 },
      )
    : cfFetch(url, init);
const awsErr = (name: string, message: string) =>
  Object.assign(new Error(message), { name });

beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
});
afterAll(async () => {
  await pg.stop();
});
/** Every test starts with AWS (keys) and Cloudflare connected. */
beforeEach(async () => {
  const { updateInstanceSettings } =
    await import("@/services/instance-settings");
  await updateInstanceSettings(
    {
      awsMode: "keys",
      awsRegion: "eu-west-1",
      awsAccessKey: "AKIAEXAMPLE",
      awsSecret: "s3cr3t",
      sesConfigSet: "sendsprite",
    },
    undefined,
    { audit: false },
  );
  const { connectCloudflare } = await import("@/services/cloudflare-connect");
  const cf = await connectCloudflare(
    "cf-token-value-0123456789",
    { userId: "u1" },
    cfFetch,
  );
  if (!cf.ok) throw new Error(cf.error);
  cfCalls.length = 0;
});
afterEach(() => {
  ses.reset();
  cfCalls.length = 0;
});

const actor = {
  userId: "u1",
  teamId: "org_1",
  teamName: "Acme",
  role: "owner" as const,
};
const noop = { enqueue: async () => "", fetch: cfFetch };
const emptyDns: Resolver = {
  resolveCname: async () => [],
  resolveMx: async () => [],
  resolveTxt: async () => [],
};
const pendingIdentity = {
  DkimAttributes: { Status: "PENDING" as const, Tokens: ["t1", "t2", "t3"] },
  MailFromAttributes: {
    MailFromDomain: "bounce.x",
    MailFromDomainStatus: "PENDING" as const,
    BehaviorOnMxFailure: "USE_DEFAULT_VALUE" as const,
  },
};

async function byName(name: string) {
  const [d] = await pg.db.select().from(domains).where(eq(domains.name, name));
  if (!d) throw new Error(`domain ${name} missing`);
  return d;
}
async function disconnectCloudflare() {
  const { updateInstanceSettings } =
    await import("@/services/instance-settings");
  await updateInstanceSettings({ cloudflareToken: null }, undefined, {
    audit: false,
  });
}
function happyProvision() {
  ses.on(CreateEmailIdentityCommand).resolves({
    DkimAttributes: { Tokens: ["t1", "t2", "t3"], Status: "PENDING" },
  });
  ses.on(PutEmailIdentityMailFromAttributesCommand).resolves({});
}

/** One domain's life: create → provision → verify → delete, in order. */
describe("domains", () => {
  it("createDomain picks auto mode when a zone matches and enqueues provisioning", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createDomain } = await import("@/services/domains");
    const res = await createDomain(
      actor,
      { name: "Mail.Acme.com" },
      { enqueue, fetch: cfFetch },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      name: "mail.acme.com",
      dnsMode: "auto",
      cloudflareZoneId: "z1",
      status: "pending",
      mailFromDomain: "bounce.mail.acme.com",
      region: "eu-west-1",
    });
    expect(res.data.verifyUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(enqueue).toHaveBeenCalledWith("domain.provision", {
      domainId: res.data.id,
    });
  });
  it("createDomain strips a trailing dot before validating", async () => {
    const { createDomain } = await import("@/services/domains");
    const res = await createDomain(actor, { name: "dot.acme.com." }, noop);
    expect(res).toMatchObject({
      ok: true,
      data: { name: "dot.acme.com", dnsMode: "auto" },
    });
    // Later tests count rows; drop this one.
    await pg.db.delete(domains).where(eq(domains.name, "dot.acme.com"));
  });
  it("manual mode when no zone matches: provisioning touches SES only", async () => {
    const { createDomain, provisionDomain, deleteDomain } =
      await import("@/services/domains");
    const res = await createDomain(actor, { name: "mail.other.io" }, noop);
    expect(res).toMatchObject({
      ok: true,
      data: { dnsMode: "manual", cloudflareZoneId: null },
    });
    if (!res.ok) return;
    happyProvision();
    cfCalls.length = 0;
    const enqueue = vi.fn(async () => "job");
    await provisionDomain(res.data.id, { enqueue, fetch: cfFetch });
    const after = await byName("mail.other.io");
    expect(after.expectedRecords).toHaveLength(6);
    expect(after.expectedRecords.some((r) => r.cloudflareId)).toBe(false);
    expect(cfCalls).toHaveLength(0);
    expect(enqueue).toHaveBeenCalledWith(
      "domain.verify",
      { domainId: res.data.id },
      { startAfter: 30, singletonKey: res.data.id },
    );
    ses.on(DeleteEmailIdentityCommand).resolves({});
    cfCalls.length = 0;
    expect(await deleteDomain(actor, res.data.id, noop)).toEqual({
      ok: true,
      data: { leftoverDnsRecords: 0 },
    });
    expect(cfCalls).toHaveLength(0);
  });
  it("rejects duplicates and invalid names; member cannot create; needs AWS", async () => {
    const { createDomain } = await import("@/services/domains");
    expect(
      (await createDomain(actor, { name: "mail.acme.com" }, noop)).ok,
    ).toBe(false);
    expect(
      (await createDomain(actor, { name: "MAIL.acme.com " }, noop)).ok,
    ).toBe(false);
    expect((await createDomain(actor, { name: "not a domain" }, noop)).ok).toBe(
      false,
    );
    expect(
      (
        await createDomain(
          { ...actor, role: "member" },
          { name: "x.acme.com" },
          noop,
        )
      ).ok,
    ).toBe(false);
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    await updateInstanceSettings({ awsMode: "none" }, undefined, {
      audit: false,
    });
    const res = await createDomain(actor, { name: "y.acme.com" }, noop);
    expect(res).toMatchObject({ ok: false, error: /Connect AWS/ });
    expect(await pg.db.select().from(domains)).toHaveLength(1);
  });
  it("createDomain keeps the row when the queue is down; retryProvisioning re-sends", async () => {
    const { createDomain, retryProvisioning } =
      await import("@/services/domains");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let res;
    try {
      res = await createDomain(
        actor,
        { name: "queued.acme.com" },
        {
          enqueue: async () => {
            throw new Error("pg-boss is not started");
          },
          fetch: cfFetch,
        },
      );
    } finally {
      err.mockRestore();
    }
    expect(res).toMatchObject({
      ok: true,
      data: {
        status: "pending",
        dkimTokens: [],
        lastError: "Could not queue provisioning: pg-boss is not started",
      },
    });
    if (!res.ok) return;
    const id = res.data.id;
    // Never provisioned, so the sweep must not pick it up.
    const { selectSweepCandidates } = await import("@/services/domains");
    expect(await selectSweepCandidates()).not.toContain(id);
    const enqueue = vi.fn(async () => "job");
    expect(
      (await retryProvisioning({ ...actor, role: "member" }, id, { enqueue }))
        .ok,
    ).toBe(false);
    expect(await retryProvisioning(actor, id, { enqueue })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(enqueue).toHaveBeenCalledWith("domain.provision", { domainId: id });
    expect(await byName("queued.acme.com")).toMatchObject({
      status: "pending",
      lastError: null,
    });
    expect(
      await pg.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "domains.retry_provisioning")),
    ).toHaveLength(1);
    // The queue failing again is reported and recorded.
    expect(
      await retryProvisioning(actor, id, {
        enqueue: async () => {
          throw new Error("still down");
        },
      }),
    ).toEqual({ ok: false, error: "Could not queue provisioning: still down" });
    expect((await byName("queued.acme.com")).lastError).toMatch(/still down/);
    // Once provisioned, Re-verify is the tool, not a second provision.
    await pg.db
      .update(domains)
      .set({ dkimTokens: ["t1"] })
      .where(eq(domains.id, id));
    expect((await retryProvisioning(actor, id, { enqueue })).ok).toBe(false);
    await pg.db.delete(domains).where(eq(domains.id, id));
  });
  it("provisionDomain creates the identity, MAIL FROM, writes records to Cloudflare", async () => {
    happyProvision();
    const { provisionDomain } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    const enqueue = vi.fn(async () => "job");
    await provisionDomain(d.id, { enqueue, fetch: cfFetch });
    const after = await byName("mail.acme.com");
    expect(after.dkimTokens).toEqual(["t1", "t2", "t3"]);
    expect(after.dkimStatus).toBe("PENDING");
    expect(after.lastError).toBeNull();
    expect(after.expectedRecords).toHaveLength(6);
    expect(after.expectedRecords.every((r) => r.cloudflareId)).toBe(true);
    expect(cfCalls.filter((c) => c.method === "POST")).toHaveLength(6);
    expect(
      ses.commandCalls(CreateEmailIdentityCommand)[0]!.args[0].input,
    ).toEqual({
      EmailIdentity: "mail.acme.com",
      ConfigurationSetName: "sendsprite",
      DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
    });
    expect(
      ses.commandCalls(PutEmailIdentityMailFromAttributesCommand)[0]!.args[0]
        .input,
    ).toEqual({
      EmailIdentity: "mail.acme.com",
      MailFromDomain: "bounce.mail.acme.com",
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    });
    expect(enqueue).toHaveBeenCalledWith(
      "domain.verify",
      { domainId: d.id },
      { startAfter: 30, singletonKey: d.id },
    );
  });
  it("a Cloudflare failure mid-loop leaves the ids already created on the row", async () => {
    happyProvision();
    ses.on(DeleteEmailIdentityCommand).resolves({});
    const { createDomain, provisionDomain, deleteDomain } =
      await import("@/services/domains");
    const res = await createDomain(actor, { name: "partial.acme.com" }, noop);
    if (!res.ok) throw new Error(res.error);
    let posts = 0;
    const cfThirdFails: FetchLike = async (url, init) => {
      if (init?.method === "POST" && ++posts === 3)
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "Cloudflare hiccup" }],
          }),
          { status: 500 },
        );
      return cfFetch(url, init);
    };
    await expect(
      provisionDomain(res.data.id, {
        enqueue: noop.enqueue,
        fetch: cfThirdFails,
      }),
    ).rejects.toThrow(/hiccup/);
    const after = await byName("partial.acme.com");
    expect(after.dkimTokens).toEqual(["t1", "t2", "t3"]);
    expect(after.lastError).toMatch(/hiccup/);
    expect(after.expectedRecords).toHaveLength(6);
    expect(
      after.expectedRecords.filter((r) => r.cloudflareId).map((r) => r.kind),
    ).toEqual(["DKIM", "DKIM"]);
    // The retry (upsert by type+name) fills in the rest and clears the error.
    await provisionDomain(res.data.id, {
      enqueue: noop.enqueue,
      fetch: cfFetch,
    });
    const retried = await byName("partial.acme.com");
    expect(retried.expectedRecords.every((r) => r.cloudflareId)).toBe(true);
    expect(retried.lastError).toBeNull();
    expect((await deleteDomain(actor, res.data.id, noop)).ok).toBe(true);
  });
  it("re-provisioning patches the records Cloudflare already has and keeps their ids", async () => {
    happyProvision();
    const { provisionDomain } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    await provisionDomain(d.id, { enqueue: async () => "", fetch: cfExisting });
    const after = await byName("mail.acme.com");
    expect(cfCalls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(cfCalls.filter((c) => c.method === "PATCH")).toHaveLength(6);
    expect(after.expectedRecords.map((r) => r.cloudflareId)).toEqual(
      after.expectedRecords.map((r) => `e-${r.type}-${r.name}`),
    );
    // Restore the ids the delete test expects to remove.
    await provisionDomain(d.id, { enqueue: async () => "", fetch: cfFetch });
  });
  it("provisionDomain converges when the identity already exists", async () => {
    ses
      .on(CreateEmailIdentityCommand)
      .rejects(awsErr("AlreadyExistsException", "exists"));
    ses.on(GetEmailIdentityCommand).resolves(pendingIdentity);
    ses.on(PutEmailIdentityMailFromAttributesCommand).resolves({});
    const { provisionDomain } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    await provisionDomain(d.id, { enqueue: async () => "", fetch: cfFetch });
    expect((await byName("mail.acme.com")).dkimTokens).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });
  it("provisionDomain records the error and rethrows so pg-boss retries", async () => {
    ses
      .on(CreateEmailIdentityCommand)
      .rejects(awsErr("TooManyRequestsException", "Rate exceeded"));
    const { provisionDomain } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    const enqueue = vi.fn(async () => "job");
    await expect(
      provisionDomain(d.id, { enqueue, fetch: cfFetch }),
    ).rejects.toThrow(/Rate exceeded/);
    expect((await byName("mail.acme.com")).lastError).toMatch(/Rate exceeded/);
    expect(enqueue).not.toHaveBeenCalled();
    expect((await byName("mail.acme.com")).status).toBe("pending");
    // The handler's final attempt is terminal: the domain is marked failed.
    await expect(
      provisionDomain(
        d.id,
        { enqueue, fetch: cfFetch },
        { finalAttempt: true },
      ),
    ).rejects.toThrow(/Rate exceeded/);
    expect(await byName("mail.acme.com")).toMatchObject({
      status: "failed",
      lastError: /Rate exceeded/,
    });
    await pg.db
      .update(domains)
      .set({ status: "pending" })
      .where(eq(domains.id, d.id));
  });
  it("auto mode degrades to manual when Cloudflare is disconnected mid-flight", async () => {
    const { createDomain, provisionDomain, deleteDomain } =
      await import("@/services/domains");
    const res = await createDomain(actor, { name: "deg.acme.com" }, noop);
    if (!res.ok) throw new Error(res.error);
    expect(res.data.dnsMode).toBe("auto");
    await disconnectCloudflare();
    happyProvision();
    const enqueue = vi.fn(async () => "job");
    await provisionDomain(res.data.id, { enqueue, fetch: cfFetch });
    const after = await byName("deg.acme.com");
    expect(after).toMatchObject({
      dnsMode: "manual",
      lastError: /Cloudflare is not connected/,
    });
    expect(after.expectedRecords).toHaveLength(6);
    expect(after.expectedRecords.some((r) => r.cloudflareId)).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
    ses.on(DeleteEmailIdentityCommand).resolves({});
    expect((await deleteDomain(actor, res.data.id, noop)).ok).toBe(true);
  });
  it("verifyDomain flips to verified when SES + DNS agree", async () => {
    ses.on(GetEmailIdentityCommand).resolves({
      DkimAttributes: { Status: "SUCCESS", Tokens: ["t1", "t2", "t3"] },
      MailFromAttributes: {
        MailFromDomainStatus: "SUCCESS",
        MailFromDomain: "bounce.mail.acme.com",
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
      },
      VerifiedForSendingStatus: true,
    });
    const resolver: Resolver = {
      resolveCname: async () => ["t1.dkim.amazonses.com"],
      resolveMx: async () => [
        { exchange: "feedback-smtp.eu-west-1.amazonses.com", priority: 10 },
      ],
      resolveTxt: async (n) =>
        n.startsWith("_dmarc")
          ? [["v=DMARC1; p=none"]]
          : [["v=spf1 include:amazonses.com ~all"]],
    };
    const { verifyDomain } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    await verifyDomain(d.id, { resolver });
    const after = await byName("mail.acme.com");
    expect(after).toMatchObject({
      status: "verified",
      dkimStatus: "SUCCESS",
      mailFromStatus: "SUCCESS",
      spfOk: true,
      dmarcOk: true,
      lastError: null,
    });
    expect(after.verifiedAt).toBeInstanceOf(Date);
    expect(after.lastCheckedAt).toBeInstanceOf(Date);
    // Already verified: a stray re-run is a no-op.
    ses.reset();
    await verifyDomain(d.id, { resolver });
    expect(ses.commandCalls(GetEmailIdentityCommand)).toHaveLength(0);
  });
  it("reverifyDomain keeps a verified domain verified, demotes only when SES disagrees", async () => {
    const { reverifyDomain } = await import("@/services/domains");
    const before = await byName("mail.acme.com");
    expect(before.status).toBe("verified");
    const success = {
      DkimAttributes: {
        Status: "SUCCESS" as const,
        Tokens: ["t1", "t2", "t3"],
      },
      MailFromAttributes: {
        MailFromDomainStatus: "SUCCESS" as const,
        MailFromDomain: "bounce.mail.acme.com",
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE" as const,
      },
    };
    ses.on(GetEmailIdentityCommand).resolves(success);
    expect(
      (await reverifyDomain(actor, before.id, { resolver: emptyDns })).ok,
    ).toBe(true);
    const still = await byName("mail.acme.com");
    expect(still.status).toBe("verified");
    expect(still.verifiedAt!.getTime()).toBe(before.verifiedAt!.getTime());
    expect(still.lastCheckedAt!.getTime()).toBeGreaterThan(
      before.lastCheckedAt!.getTime(),
    );
    // SES no longer agrees: demoted to pending, verifiedAt cleared.
    ses.reset();
    ses.on(GetEmailIdentityCommand).resolves(pendingIdentity);
    expect(
      (await reverifyDomain(actor, before.id, { resolver: emptyDns })).ok,
    ).toBe(true);
    const demoted = await byName("mail.acme.com");
    expect(demoted.status).toBe("pending");
    expect(demoted.verifiedAt).toBeNull();
    // Later tests expect the fixture verified again.
    ses.reset();
    ses.on(GetEmailIdentityCommand).resolves(success);
    expect(
      (await reverifyDomain(actor, before.id, { resolver: emptyDns })).ok,
    ).toBe(true);
    expect((await byName("mail.acme.com")).status).toBe("verified");
  });
  it("verifyDomain leaves a pending domain to the sweep and fails it after verifyUntil", async () => {
    ses.on(GetEmailIdentityCommand).resolves(pendingIdentity);
    const { verifyDomain, createDomain, selectSweepCandidates } =
      await import("@/services/domains");
    const created = await createDomain(actor, { name: "slow.acme.com" }, noop);
    if (!created.ok) throw new Error(created.error);
    const id = created.data.id;
    // Not provisioned yet (no tokens): the sweep ignores it.
    expect(await selectSweepCandidates()).toEqual([]);
    await pg.db
      .update(domains)
      .set({ dkimTokens: ["t1", "t2", "t3"] })
      .where(eq(domains.id, id));
    // Never checked: due. (mail.acme.com is verified, so it stays out.)
    expect(await selectSweepCandidates()).toEqual([id]);
    await verifyDomain(id, { resolver: emptyDns });
    await verifyDomain(id, { resolver: emptyDns });
    expect((await byName("slow.acme.com")).status).toBe("pending");
    // Just checked: not due until the check is ~100 s old.
    expect(await selectSweepCandidates()).toEqual([]);
    await pg.db
      .update(domains)
      .set({ lastCheckedAt: new Date(Date.now() - 101_000) })
      .where(eq(domains.id, id));
    expect(await selectSweepCandidates()).toEqual([id]);
    // Past the window it is still due, and the check fails it for good.
    await pg.db
      .update(domains)
      .set({ verifyUntil: new Date(Date.now() - 1000) })
      .where(eq(domains.id, id));
    expect(await selectSweepCandidates()).toEqual([id]);
    await verifyDomain(id, { resolver: emptyDns });
    const after = await byName("slow.acme.com");
    expect(after.status).toBe("failed");
    expect(after.lastError).toMatch(/timed out/);
    expect(await selectSweepCandidates()).toEqual([]);
  });
  it("reverifyDomain resets the window, audits, and checks inline", async () => {
    ses.on(GetEmailIdentityCommand).resolves(pendingIdentity);
    const { reverifyDomain } = await import("@/services/domains");
    // Re-verify needs a provisioned identity; the fixture skipped the job.
    await pg.db
      .update(domains)
      .set({ dkimTokens: ["t1", "t2", "t3"] })
      .where(eq(domains.name, "slow.acme.com"));
    const d = await byName("slow.acme.com");
    const deps = { resolver: emptyDns };
    expect(
      (await reverifyDomain({ ...actor, role: "member" }, d.id, deps)).ok,
    ).toBe(false);
    expect(await reverifyDomain(actor, d.id, deps)).toEqual({
      ok: true,
      data: undefined,
    });
    expect(ses.commandCalls(GetEmailIdentityCommand)).toHaveLength(1);
    const after = await byName("slow.acme.com");
    expect(after.status).toBe("pending");
    expect(after.lastError).toBeNull();
    expect(after.verifyUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(after.lastCheckedAt!.getTime()).toBeGreaterThan(
      d.lastCheckedAt!.getTime(),
    );
    expect(
      await pg.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "domains.reverify"),
            eq(auditLog.targetId, d.id),
          ),
        ),
    ).toHaveLength(1);
    // A failing check is reported, not thrown.
    ses.reset();
    ses
      .on(GetEmailIdentityCommand)
      .rejects(awsErr("TooManyRequestsException", "Rate exceeded"));
    expect(await reverifyDomain(actor, d.id, deps)).toMatchObject({
      ok: false,
      error: /Rate exceeded/,
    });
  });
  it("reverifyDomain refuses a domain that has not been provisioned", async () => {
    const { createDomain, reverifyDomain } = await import("@/services/domains");
    const enqueue = vi.fn(async () => "job");
    const res = await createDomain(
      actor,
      { name: "unprovisioned.acme.com" },
      { enqueue, fetch: cfFetch },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    ses.reset();
    expect(await reverifyDomain(actor, res.data.id)).toEqual({
      ok: false,
      error: "Provisioning hasn't finished yet.",
    });
    expect(ses.commandCalls(GetEmailIdentityCommand)).toHaveLength(0);
    // Later assertions list the team's domains; leave only the fixture.
    await pg.db.delete(domains).where(eq(domains.id, res.data.id));
  });
  it("verifyDomain records the error without throwing when AWS is disconnected", async () => {
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    await updateInstanceSettings({ awsMode: "none" }, undefined, {
      audit: false,
    });
    const { verifyDomain } = await import("@/services/domains");
    const d = await byName("slow.acme.com");
    await verifyDomain(d.id, { resolver: emptyDns });
    const after = await byName("slow.acme.com");
    expect(after.status).toBe("pending");
    expect(after.lastError).toMatch(/AWS is not connected/);
    expect(after.lastCheckedAt!.getTime()).toBeGreaterThan(
      d.lastCheckedAt!.getTime(),
    );
    expect(ses.commandCalls(GetEmailIdentityCommand)).toHaveLength(0);
  });
  it("verifyDomain records other SES errors and rethrows for retry", async () => {
    ses
      .on(GetEmailIdentityCommand)
      .rejects(awsErr("TooManyRequestsException", "Rate exceeded"));
    const { verifyDomain } = await import("@/services/domains");
    const d = await byName("slow.acme.com");
    await expect(verifyDomain(d.id, { resolver: emptyDns })).rejects.toThrow(
      /Rate exceeded/,
    );
    const after = await byName("slow.acme.com");
    expect(after.status).toBe("pending");
    expect(after.lastError).toMatch(/Rate exceeded/);
  });
  it("verifyDomain fails the domain when the SES identity has vanished", async () => {
    ses
      .on(GetEmailIdentityCommand)
      .rejects(awsErr("NotFoundException", "identity not found"));
    const { verifyDomain } = await import("@/services/domains");
    const d = await byName("slow.acme.com");
    await verifyDomain(d.id, { resolver: emptyDns });
    const after = await byName("slow.acme.com");
    expect(after.status).toBe("failed");
    expect(after.lastError).toMatch(/identity was removed/);
  });
  it("deleteDomain removes the identity and the Cloudflare records it created", async () => {
    ses.on(DeleteEmailIdentityCommand).resolves({});
    const { deleteDomain, listDomains } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    expect(
      (await deleteDomain({ ...actor, role: "member" }, d.id, noop)).ok,
    ).toBe(false);
    expect(
      (await deleteDomain({ ...actor, teamId: "org_other" }, d.id, noop)).ok,
    ).toBe(false);
    expect(await deleteDomain(actor, d.id, { fetch: cfFetch })).toEqual({
      ok: true,
      data: { leftoverDnsRecords: 0 },
    });
    expect(cfCalls.filter((c) => c.method === "DELETE")).toHaveLength(6);
    expect(
      ses.commandCalls(DeleteEmailIdentityCommand)[0]!.args[0].input,
    ).toEqual({ EmailIdentity: "mail.acme.com" });
    expect(
      await pg.db.select().from(domains).where(eq(domains.id, d.id)),
    ).toHaveLength(0);
    expect((await listDomains("org_1")).map((x) => x.name)).toEqual([
      "slow.acme.com",
    ]);
  });
  it("deleteDomain reports Cloudflare records it could not remove", async () => {
    happyProvision();
    ses.on(DeleteEmailIdentityCommand).resolves({});
    const { createDomain, provisionDomain, deleteDomain } =
      await import("@/services/domains");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Cloudflare refuses the deletes.
      const a = await createDomain(actor, { name: "left.acme.com" }, noop);
      if (!a.ok) throw new Error(a.error);
      await provisionDomain(a.data.id, {
        enqueue: async () => "",
        fetch: cfFetch,
      });
      expect(
        await deleteDomain(actor, a.data.id, { fetch: cfNoDelete }),
      ).toEqual({ ok: true, data: { leftoverDnsRecords: 6 } });
      expect(warn).toHaveBeenCalledTimes(6);
      expect(warn.mock.calls[0]![0]).toMatch(/could not delete Cloudflare/);
      // Cloudflare disconnected: nothing is attempted, everything is left.
      warn.mockClear();
      const b = await createDomain(actor, { name: "gone.acme.com" }, noop);
      if (!b.ok) throw new Error(b.error);
      await provisionDomain(b.data.id, {
        enqueue: async () => "",
        fetch: cfFetch,
      });
      await disconnectCloudflare();
      cfCalls.length = 0;
      expect(await deleteDomain(actor, b.data.id, { fetch: cfFetch })).toEqual({
        ok: true,
        data: { leftoverDnsRecords: 6 },
      });
      expect(cfCalls).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect((await pg.db.select().from(domains)).map((d) => d.name)).toEqual([
      "slow.acme.com",
    ]);
  });
  it("deleteDomain with AWS disconnected removes the row and reports every record as left over", async () => {
    happyProvision();
    const { createDomain, provisionDomain, deleteDomain } =
      await import("@/services/domains");
    const res = await createDomain(actor, { name: "off.acme.com" }, noop);
    if (!res.ok) throw new Error(res.error);
    await provisionDomain(res.data.id, {
      enqueue: noop.enqueue,
      fetch: cfFetch,
    });
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    await updateInstanceSettings({ awsMode: "none" }, undefined, {
      audit: false,
    });
    ses.reset();
    cfCalls.length = 0;
    expect(await deleteDomain(actor, res.data.id, { fetch: cfFetch })).toEqual({
      ok: true,
      data: { leftoverDnsRecords: 6 },
    });
    expect(ses.calls()).toHaveLength(0);
    expect(cfCalls).toHaveLength(0);
    expect(
      await pg.db.select().from(domains).where(eq(domains.id, res.data.id)),
    ).toHaveLength(0);
    expect(
      await pg.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "domains.delete")),
    ).not.toHaveLength(0);
  });
  it("deleteDomain tolerates a missing identity and keeps the row when SES fails", async () => {
    const { deleteDomain } = await import("@/services/domains");
    const d = await byName("slow.acme.com");
    ses
      .on(DeleteEmailIdentityCommand)
      .rejects(awsErr("AccessDeniedException", "not authorized"));
    expect(await deleteDomain(actor, d.id, noop)).toMatchObject({
      ok: false,
      error: /not authorized/,
    });
    expect(await byName("slow.acme.com")).toBeTruthy();
    ses.reset();
    ses
      .on(DeleteEmailIdentityCommand)
      .rejects(awsErr("NotFoundException", "gone"));
    expect((await deleteDomain(actor, d.id, noop)).ok).toBe(true);
    expect(await pg.db.select().from(domains)).toHaveLength(0);
  });
});
```

Run: `cd apps/web && bun run test:integration -- domains` → FAIL.

- [x] **Step 2: Service**

`apps/web/src/services/domains.ts`:

```ts
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
} from "@aws-sdk/client-sesv2";
import { can, newId } from "@sendsprite/shared";
import { db } from "@/db";
import { domains } from "@/db/schema";
import { makeSes } from "@/lib/aws/clients";
import { resolveAwsContext } from "@/lib/aws/credentials";
import type { FetchLike } from "@/lib/cloudflare/client";
import { expectedRecords } from "@/lib/dns/records";
import { matchZone } from "@/lib/dns/zone-match";
import { checkRecords, type Resolver } from "@/lib/dns/check";
import { recordAudit } from "@/lib/audit";
import type { Result } from "@/lib/result";
import { getInstanceSettings } from "./instance-settings";
import { cloudflareClient, listZones } from "./cloudflare-connect";
import type { TeamActor } from "./team";

export type Domain = typeof domains.$inferSelect;

/**
 * `startAfter` is a delay in seconds (pg-boss casts a number to an interval).
 * `singletonKey` dedups on a queue with a policy that enforces it: the
 * `domain.verify` queue is `exclusive`, so one verify job per domain can be
 * created/retry/active at a time and a duplicate send is dropped (null).
 * Resolves to the job id, or null when deduped.
 */
export type Enqueue = (
  queue: string,
  data: object,
  opts?: { startAfter?: number; singletonKey?: string },
) => Promise<unknown>;

/** Injection points: the job queue, Cloudflare's fetch, and the DNS resolver. */
interface Deps {
  enqueue: Enqueue;
  fetch?: FetchLike;
  resolver?: Resolver;
}

/**
 * A pending domain is re-checked by the `domain.verify-sweep` cron (every
 * 2 minutes; see jobs/handlers/domain-verify.ts) for 72 hours before it
 * fails. The sweep skips rows checked within SWEEP_STALE_S so a tick never
 * re-runs a check the previous tick just finished.
 */
const SWEEP_STALE_S = 100;
const FIRST_VERIFY_AFTER_S = 30;
const VERIFY_WINDOW_MS = 72 * 3600 * 1000;
const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DENIED: Result<never> = {
  ok: false,
  error: "You don't have permission to do that.",
};
const DUPLICATE: Result<never> = {
  ok: false,
  error: "That domain is already added on this instance.",
};
const CF_DISCONNECTED =
  "Cloudflare is not connected; add the records manually.";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errName = (e: unknown) =>
  typeof e === "object" && e !== null
    ? (e as { name?: string }).name
    : undefined;
/** Postgres SQLSTATE, on the driver error or (drizzle) its `cause`. */
const pgCode = (e: unknown): string | undefined => {
  const o = e as { code?: string; cause?: { code?: string } } | null;
  return o?.code ?? o?.cause?.code;
};

export async function listDomains(teamId: string): Promise<Domain[]> {
  return db()
    .select()
    .from(domains)
    .where(eq(domains.teamId, teamId))
    .orderBy(domains.createdAt);
}

export async function getDomain(
  teamId: string,
  id: string,
): Promise<Domain | null> {
  const [d] = await db()
    .select()
    .from(domains)
    .where(and(eq(domains.id, id), eq(domains.teamId, teamId)))
    .limit(1);
  return d ?? null;
}

async function loadById(id: string): Promise<Domain | undefined> {
  const [d] = await db()
    .select()
    .from(domains)
    .where(eq(domains.id, id))
    .limit(1);
  return d;
}

function enqueueVerify(enqueue: Enqueue, domainId: string, startAfter = 0) {
  return enqueue(
    "domain.verify",
    { domainId },
    { startAfter, singletonKey: domainId },
  );
}

/**
 * Add a sending domain. Picks `auto` DNS mode when a connected Cloudflare
 * zone covers the name, `manual` otherwise, then queues provisioning.
 */
export async function createDomain(
  actor: TeamActor,
  input: unknown,
  deps: Deps,
): Promise<Result<Domain>> {
  if (!can(actor.role, "domains.manage")) return DENIED;
  const parsed = z
    .object({
      name: z
        .string()
        .transform((s) => s.trim().toLowerCase().replace(/\.$/, "")),
    })
    .safeParse(input);
  if (!parsed.success || !DOMAIN_RE.test(parsed.data.name))
    return { ok: false, error: "Enter a valid domain like mail.example.com." };
  const name = parsed.data.name;
  const settings = await getInstanceSettings();
  if (settings.awsMode === "none" || !settings.awsRegion)
    return { ok: false, error: "Connect AWS first (Settings → Instance)." };
  const [dupe] = await db()
    .select({ id: domains.id })
    .from(domains)
    .where(eq(domains.name, name))
    .limit(1);
  if (dupe) return DUPLICATE;
  const zone = matchZone(name, await listZones(deps.fetch));
  const id = newId("dom");
  let row: Domain | undefined;
  try {
    [row] = await db()
      .insert(domains)
      .values({
        id,
        teamId: actor.teamId,
        name,
        region: settings.awsRegion,
        cloudflareZoneId: zone?.id ?? null,
        dnsMode: zone ? "auto" : "manual",
        mailFromDomain: `bounce.${name}`,
        verifyUntil: new Date(Date.now() + VERIFY_WINDOW_MS),
        createdBy: actor.userId,
      })
      .returning();
  } catch (e) {
    // Two concurrent adds of the same name: the unique index decides.
    if (pgCode(e) === "23505") return DUPLICATE;
    throw e;
  }
  if (!row) throw new Error("domains insert returned no row");
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "domains.create",
    targetType: "domain",
    targetId: id,
    diff: { name: { to: name }, dnsMode: { to: row.dnsMode } },
    ...actor.meta,
  });
  // The queue can be unreachable (pg-boss down, schema missing) while the
  // row is already there; keep the domain and surface the problem on it so
  // "Retry provisioning" can re-send instead of the user re-adding.
  try {
    await deps.enqueue("domain.provision", { domainId: id });
  } catch (e) {
    const lastError = `Could not queue provisioning: ${errMsg(e)}`;
    [row] = await db()
      .update(domains)
      .set({ lastError })
      .where(eq(domains.id, id))
      .returning();
    if (!row) throw new Error("domains update returned no row");
    console.error(`[domains] ${lastError}`);
  }
  return { ok: true, data: row };
}

/**
 * Re-send `domain.provision` for a domain whose provisioning never ran
 * (queue failure at create time) or failed terminally. Refused once the
 * identity exists (tokens stored): Re-verify covers that case.
 */
export async function retryProvisioning(
  actor: TeamActor,
  id: string,
  deps: Pick<Deps, "enqueue">,
): Promise<Result> {
  if (!can(actor.role, "domains.manage")) return DENIED;
  const d = await getDomain(actor.teamId, id);
  if (!d) return { ok: false, error: "Domain not found." };
  if (d.dkimTokens.length > 0)
    return { ok: false, error: "This domain is already provisioned." };
  await db()
    .update(domains)
    .set({
      status: "pending",
      lastError: null,
      verifyUntil: new Date(Date.now() + VERIFY_WINDOW_MS),
    })
    .where(eq(domains.id, id));
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "domains.retry_provisioning",
    targetType: "domain",
    targetId: id,
    diff: { status: { from: d.status, to: "pending" } },
    ...actor.meta,
  });
  try {
    await deps.enqueue("domain.provision", { domainId: id });
  } catch (e) {
    const lastError = `Could not queue provisioning: ${errMsg(e)}`;
    await db().update(domains).set({ lastError }).where(eq(domains.id, id));
    return { ok: false, error: lastError };
  }
  return { ok: true, data: undefined };
}

/**
 * Job: SES identity + MAIL FROM + (auto mode) Cloudflare records, then
 * schedule the first verification. Idempotent: an existing identity is
 * read back for its tokens and Cloudflare upserts by (type, name[, content]).
 * The tokens and expected records are persisted before the Cloudflare loop
 * and each record's `cloudflareId` right after its upsert, so a failure
 * mid-loop leaves the ids already created on the row (delete removes them;
 * the retry patches instead of duplicating). Auto mode with Cloudflare
 * disconnected degrades to manual (records are still computed for the user
 * to add by hand). Throws after recording
 * `lastError` so pg-boss retries; on the handler's `finalAttempt` the
 * domain is also marked `failed` (no more retries are coming).
 */
export async function provisionDomain(
  domainId: string,
  deps: Deps,
  { finalAttempt = false }: { finalAttempt?: boolean } = {},
): Promise<void> {
  const d = await loadById(domainId);
  if (!d) return;
  try {
    const ses = makeSes(await resolveAwsContext());
    const settings = await getInstanceSettings();
    const identity = await ses
      .send(
        new CreateEmailIdentityCommand({
          EmailIdentity: d.name,
          ConfigurationSetName: settings.sesConfigSet ?? undefined,
          DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
        }),
      )
      .catch((e: unknown) => {
        if (errName(e) !== "AlreadyExistsException") throw e;
        return ses.send(new GetEmailIdentityCommand({ EmailIdentity: d.name }));
      });
    const tokens = identity.DkimAttributes?.Tokens ?? [];
    await ses.send(
      new PutEmailIdentityMailFromAttributesCommand({
        EmailIdentity: d.name,
        MailFromDomain: d.mailFromDomain,
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
      }),
    );
    const recs = expectedRecords({
      domain: d.name,
      region: d.region,
      dkimTokens: tokens,
      mailFromDomain: d.mailFromDomain,
    });
    const persistRecords = () =>
      db()
        .update(domains)
        .set({ expectedRecords: [...recs] })
        .where(eq(domains.id, d.id));
    await db()
      .update(domains)
      .set({
        dkimTokens: tokens,
        dkimStatus: identity.DkimAttributes?.Status ?? null,
        expectedRecords: [...recs],
      })
      .where(eq(domains.id, d.id));
    let dnsMode = d.dnsMode;
    let lastError: string | null = null;
    if (d.dnsMode === "auto" && d.cloudflareZoneId) {
      const zoneId = d.cloudflareZoneId;
      const cf = await cloudflareClient(deps.fetch);
      if (cf) {
        for (const r of recs) {
          const { id } = await cf.upsertRecord(zoneId, {
            type: r.type,
            name: r.name,
            content: r.value,
            priority: r.priority,
          });
          r.cloudflareId = id;
          await persistRecords();
        }
      } else {
        dnsMode = "manual";
        lastError = CF_DISCONNECTED;
      }
    }
    await db()
      .update(domains)
      .set({ dnsMode, lastError })
      .where(eq(domains.id, d.id));
    await enqueueVerify(deps.enqueue, d.id, FIRST_VERIFY_AFTER_S);
  } catch (e) {
    await db()
      .update(domains)
      .set({
        lastError: errMsg(e),
        ...(finalAttempt && { status: "failed" as const }),
      })
      .where(eq(domains.id, d.id));
    throw e;
  }
}

async function setError(id: string, lastError: string) {
  await db()
    .update(domains)
    .set({ lastError, lastCheckedAt: new Date() })
    .where(eq(domains.id, id));
}

/**
 * Job: poll SES + DNS once. Verified → done; pending → left for the next
 * sweep; past the window → failed. It never re-enqueues itself: the
 * `domain.verify-sweep` cron picks pending rows by `lastCheckedAt`, which
 * every outcome below bumps. AWS disconnected sets `lastError` and leaves
 * the status (the sweep keeps trying once per tick until reconnect or
 * Re-verify); the SES identity gone is `failed` (the user deletes and
 * re-adds). Any other SES error records `lastError` and rethrows so
 * pg-boss retries. A verified domain is a no-op unless `force` (Re-verify):
 * then it stays verified while SES still agrees and is demoted to pending
 * only when SES reports DKIM or MAIL FROM as no longer SUCCESS.
 */
export async function verifyDomain(
  domainId: string,
  deps: Pick<Deps, "resolver"> = {},
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  const d = await loadById(domainId);
  if (!d || (d.status === "verified" && !force)) return;
  let ses;
  try {
    ses = makeSes(await resolveAwsContext());
  } catch (e) {
    await setError(d.id, errMsg(e));
    return;
  }
  let ident;
  try {
    ident = await ses.send(
      new GetEmailIdentityCommand({ EmailIdentity: d.name }),
    );
  } catch (e) {
    if (errName(e) === "NotFoundException") {
      await db()
        .update(domains)
        .set({
          status: "failed",
          lastCheckedAt: new Date(),
          lastError: "SES identity was removed; delete and re-add the domain.",
        })
        .where(eq(domains.id, d.id));
      return;
    }
    await setError(d.id, errMsg(e));
    throw e;
  }
  const recs = await checkRecords(d.expectedRecords, deps.resolver);
  const dkimOk = ident.DkimAttributes?.Status === "SUCCESS";
  const mailFromOk =
    ident.MailFromAttributes?.MailFromDomainStatus === "SUCCESS";
  const spfOk = recs.some((r) => r.kind === "MAIL_FROM_SPF" && r.ok);
  const dmarcOk = recs.some((r) => r.kind === "DMARC" && r.ok);
  // SES is the authority on sending; SPF/DMARC are advisory and shown per-record.
  const verified = dkimOk && mailFromOk;
  const expired =
    !verified && !!d.verifyUntil && d.verifyUntil.getTime() < Date.now();
  await db()
    .update(domains)
    .set({
      expectedRecords: recs,
      dkimStatus: ident.DkimAttributes?.Status ?? null,
      mailFromStatus: ident.MailFromAttributes?.MailFromDomainStatus ?? null,
      spfOk,
      dmarcOk,
      lastCheckedAt: new Date(),
      status: verified ? "verified" : expired ? "failed" : "pending",
      verifiedAt: verified ? (d.verifiedAt ?? new Date()) : null,
      lastError: expired
        ? "Verification timed out after 72 hours. Check the records and click Re-verify."
        : null,
    })
    .where(eq(domains.id, d.id));
}

/**
 * Domains the verification sweep should enqueue: pending, provisioned
 * (tokens stored), and not checked within the last SWEEP_STALE_S. Rows past
 * `verifyUntil` are included on purpose: the next check marks them `failed`.
 */
export async function selectSweepCandidates(): Promise<string[]> {
  const rows = await db()
    .select({ id: domains.id })
    .from(domains)
    .where(
      and(
        eq(domains.status, "pending"),
        sql`${domains.dkimTokens} != '[]'::jsonb`,
        or(
          isNull(domains.lastCheckedAt),
          lt(
            domains.lastCheckedAt,
            sql`now() - make_interval(secs => ${SWEEP_STALE_S})`,
          ),
        ),
      ),
    )
    .orderBy(domains.createdAt);
  return rows.map((r) => r.id);
}

/**
 * Manual "Re-verify": resets the window and runs one forced check inline so
 * the click answers right away; while the domain stays pending the sweep
 * keeps checking it. A verified domain is not demoted up front: it keeps
 * its status (and `verifiedAt`) unless the check finds SES disagreeing; a
 * failed one goes back to pending so the check can decide.
 */
export async function reverifyDomain(
  actor: TeamActor,
  id: string,
  deps: Pick<Deps, "resolver"> = {},
): Promise<Result> {
  if (!can(actor.role, "domains.manage")) return DENIED;
  const d = await getDomain(actor.teamId, id);
  if (!d) return { ok: false, error: "Domain not found." };
  // Before provisioning there is no identity to check; the job will verify.
  if (d.dkimTokens.length === 0)
    return { ok: false, error: "Provisioning hasn't finished yet." };
  const status = d.status === "failed" ? "pending" : d.status;
  await db()
    .update(domains)
    .set({
      status,
      verifyUntil: new Date(Date.now() + VERIFY_WINDOW_MS),
      lastError: null,
    })
    .where(eq(domains.id, id));
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "domains.reverify",
    targetType: "domain",
    targetId: id,
    diff: { status: { from: d.status, to: status } },
    ...actor.meta,
  });
  try {
    await verifyDomain(id, deps, { force: true });
  } catch (e) {
    return { ok: false, error: `Check failed: ${errMsg(e)}` };
  }
  return { ok: true, data: undefined };
}

export interface DeleteOutcome {
  /** Cloudflare records we created but could not remove (0 in manual mode). */
  leftoverDnsRecords: number;
}

/**
 * Remove the SES identity and the Cloudflare records we created, then the
 * row. The row survives an SES failure so the user can retry; Cloudflare
 * failures are reported as `leftoverDnsRecords` rather than blocking. With
 * AWS disconnected there is nothing to clean up on either side (the SES
 * identity belongs to an account we can no longer reach, and the Cloudflare
 * records are left for the same reason); the row is just deleted and every
 * record we created counts as left over.
 */
export async function deleteDomain(
  actor: TeamActor,
  id: string,
  deps: Pick<Deps, "fetch">,
): Promise<Result<DeleteOutcome>> {
  if (!can(actor.role, "domains.manage")) return DENIED;
  const d = await getDomain(actor.teamId, id);
  if (!d) return { ok: false, error: "Domain not found." };
  const connected = (await getInstanceSettings()).awsMode !== "none";
  if (connected) {
    try {
      const ses = makeSes(await resolveAwsContext());
      await ses
        .send(new DeleteEmailIdentityCommand({ EmailIdentity: d.name }))
        .catch((e: unknown) => {
          if (errName(e) !== "NotFoundException") throw e;
        });
    } catch (e) {
      return { ok: false, error: `Could not remove: ${errMsg(e)}` };
    }
  }
  let leftoverDnsRecords = 0;
  if (!connected) {
    leftoverDnsRecords = d.expectedRecords.filter((r) => r.cloudflareId).length;
  } else if (d.dnsMode === "auto" && d.cloudflareZoneId) {
    const zoneId = d.cloudflareZoneId;
    const cf = await cloudflareClient(deps.fetch);
    for (const r of d.expectedRecords) {
      if (!r.cloudflareId) continue;
      if (!cf) {
        leftoverDnsRecords++;
        continue;
      }
      try {
        await cf.deleteRecord(zoneId, r.cloudflareId);
      } catch (e) {
        leftoverDnsRecords++;
        console.warn(
          `[domains] could not delete Cloudflare record ${r.type} ${r.name} (${r.cloudflareId}):`,
          errMsg(e),
        );
      }
    }
  }
  await db().delete(domains).where(eq(domains.id, id));
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "domains.delete",
    targetType: "domain",
    targetId: id,
    diff: { name: { from: d.name } },
    ...actor.meta,
  });
  return { ok: true, data: { leftoverDnsRecords } };
}
```

- [x] **Step 3: Job handlers**

`apps/web/src/jobs/enqueue.ts` (shared by handlers and, later, server actions):

```ts
import { getBoss } from "./boss";
import type { Enqueue } from "@/services/domains";

/**
 * Service → pg-boss bridge, shared by job handlers and server actions.
 * `startAfter` stays a number of seconds: pg-boss 12 stringifies a number
 * and Postgres casts it to an interval. `singletonKey` passes through; it
 * only dedups on a queue whose policy enforces it (see `domain-verify.ts`).
 */
export const enqueue: Enqueue = async (queue, data, opts) =>
  (await getBoss()).send(queue, data, {
    ...(opts?.startAfter !== undefined && { startAfter: opts.startAfter }),
    ...(opts?.singletonKey !== undefined && {
      singletonKey: opts.singletonKey,
    }),
  });
```

`apps/web/src/jobs/handlers/domain-provision.ts`:

```ts
import { registerQueue } from "../boss";
import { enqueue } from "../enqueue";
import { Q } from "../queues";
import { provisionDomain } from "@/services/domains";

registerQueue<{ domainId: string }>(
  Q.domainProvision,
  async (jobs) => {
    for (const job of jobs)
      await provisionDomain(
        job.data.domainId,
        { enqueue },
        // pg-boss bumps retryCount on each re-fetch, so the final attempt is
        // the one where it has reached retryLimit; that attempt's failure is
        // terminal and marks the domain `failed` (Retry provisioning re-sends).
        { finalAttempt: job.retryCount >= job.retryLimit },
      );
  },
  {
    includeMetadata: true,
    queue: {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 300,
    },
  },
);
```

`apps/web/src/jobs/handlers/domain-verify.ts`:

```ts
import { registerQueue } from "../boss";
import { enqueue } from "../enqueue";
import { Q } from "../queues";
import { selectSweepCandidates, verifyDomain } from "@/services/domains";

registerQueue<{ domainId: string }>(
  Q.domainVerify,
  async (jobs) => {
    for (const job of jobs) await verifyDomain(job.data.domainId);
  },
  {
    // `exclusive`: pg-boss 12 keeps one job per (queue, singletonKey) across
    // created/retry/active (unique index job_i6, `state <= 'active'`); a
    // duplicate `send` returns null. On the default `standard` policy a bare
    // singletonKey dedups nothing. Every verify send keys on the domain id,
    // so the sweep plus a still-queued job never fan out into two runs.
    //
    // That same index is why a verify job must not re-enqueue itself: while
    // it is `active` its own key is taken and the insert is dropped, so the
    // loop would end after one iteration. The sweep below drives the loop
    // from outside any verify job instead.
    queue: {
      policy: "exclusive",
      retryLimit: 3,
      retryDelay: 60,
      expireInSeconds: 120,
    },
  },
);

/**
 * Cron: enqueue one `domain.verify` per pending, provisioned domain whose
 * last check is older than ~100 s (so a 2-minute cron re-checks every
 * tick, and a job still queued/active is deduped by the exclusive key).
 * Expired rows stay in the set: `verifyDomain` marks them `failed` on the
 * next run, which removes them. Exported so tests can drive it directly.
 * Returns the number of domains enqueued.
 */
export async function sweepDomainVerification(): Promise<number> {
  const ids = await selectSweepCandidates();
  let sent = 0;
  for (const domainId of ids) {
    const job = await enqueue(
      Q.domainVerify,
      { domainId },
      { singletonKey: domainId },
    );
    if (job) sent++;
  }
  return sent;
}

registerQueue(Q.domainVerifySweep, () => sweepDomainVerification(), {
  cron: "*/2 * * * *",
  // retryLimit 0: a failed sweep is simply retried by the next tick.
  queue: { retryLimit: 0 },
});
```

`handlers/index.ts`: import both. pg-boss 12 `startAfter?: number | string | Date`: a number is stringified and cast to a Postgres interval, i.e. seconds — no conversion.

- [x] **Step 4: Run, commit**

Run: `cd apps/web && bun run test:integration && bun run typecheck` → PASS.

```bash
git add apps/web
git commit -m "feat(web): domains service — create, provision (SES + Cloudflare), verify loop, delete"
```

---

**Review follow-ups (applied after the Task 13 commit):**

- One verify loop per domain: the `domain.verify` queue uses `policy: "exclusive"` (`QueueOptions.policy`, create-time only) and every verify send carries `singletonKey: domainId`. pg-boss 12 keeps one job per (queue, key) across created/retry/active under that policy (unique index `job_i6`, `state <= 'active'`); a duplicate `send` returns null. A bare `singletonKey` on the default `standard` policy dedups nothing.
- `reverifyDomain` resets status/window, audits `domains.reverify`, then runs `verifyDomain` inline (a thrown check → `ok:false`); the check re-enqueues the loop itself while pending.
- `verifyDomain`: `NotFoundException` from `GetEmailIdentity` → `status: "failed"`, `lastError: "SES identity was removed; delete and re-add the domain."`, no re-enqueue, no throw. Any other SES error writes `lastError` and rethrows (pg-boss retries). AWS disconnected → `lastError`, status untouched, loop stops.
- `provisionDomain` in auto mode with Cloudflare disconnected degrades to `dnsMode: "manual"` (records computed, no `cloudflareId`), `lastError: "Cloudflare is not connected; add the records manually."`, still schedules verify.
- `createDomain` maps Postgres `23505` (error `code` or `cause.code`) from the insert to the "already added" error (concurrent adds).
- `deleteDomain` returns `Result<{ leftoverDnsRecords }>`: a failed Cloudflare delete is `console.warn`ed and counted; with Cloudflare disconnected in auto mode every record with a `cloudflareId` counts. The row is deleted either way; only an SES failure keeps it.
- `enqueue` bridge lives in `src/jobs/enqueue.ts` (`startAfter !== undefined`, `singletonKey` passthrough); `errName` is null-safe.
- `lib/dns/check.ts` SPF predicate matches `include:amazonses.com` as a whole token (`include:amazonses.com.evil.net` no longer passes).

### Task 14: Setup wizard UI + owner gating

**Files:**

- Create: `apps/web/src/app/setup/page.tsx`, `apps/web/src/app/setup/actions.ts`, `apps/web/src/app/setup/SetupWizard.tsx`, `apps/web/src/app/setup/steps/AwsStep.tsx`, `apps/web/src/app/setup/steps/ProductionStep.tsx`, `apps/web/src/app/setup/steps/CloudflareStep.tsx`, `apps/web/src/app/setup/steps/DoneStep.tsx`, `apps/web/src/app/(onboarding)/waiting/page.tsx`
- Modify: `apps/web/src/app/app/layout.tsx`, `apps/web/src/lib/session.ts` (`requireOwner`)

- [x] **Step 1: Owner helper + gating**

`session.ts`: add

```ts
/** Instance-level actions: any owner of any team may perform them (§6.1: "first user"; later owners too). */
export async function requireOwner() {
  const ctx = await requireTeam();
  if (ctx.role !== "owner") redirect("/app");
  return ctx;
}
```

`app/app/layout.tsx`: after `requireTeam()`, `const s = await getInstanceSettings(); if (!s.setupCompleted) { if (ctx.role === "owner") redirect("/setup"); else redirect("/app/waiting"); }` — but `/app/waiting` is under this layout; render it without the redirect by checking `headers().get("x-invoke-path")`? No — simpler: move waiting to `apps/web/src/app/(onboarding)/waiting/page.tsx` (outside `/app`) and redirect there. It says "An owner is finishing setup. Refresh in a minute." with the owner emails.

- [x] **Step 2: Server actions**

`apps/web/src/app/setup/actions.ts`:

```ts
"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { loadEnv } from "@/env.schema";
import { requireOwner } from "@/lib/session";
import { requestMeta } from "@/lib/audit";
import { buildQuickCreateUrl } from "@/lib/aws/quick-create";
import { SES_REGIONS } from "@/lib/aws/clients";
import * as aws from "@/services/aws-connect";
import * as cf from "@/services/cloudflare-connect";
import { issueSetupToken } from "@/services/setup-tokens";
import { updateInstanceSettings } from "@/services/instance-settings";
export type { Result } from "@/lib/result";

async function actor() {
  const ctx = await requireOwner();
  return { userId: ctx.userId, meta: requestMeta(await headers()) };
}
const region = (v: unknown) =>
  (SES_REGIONS as readonly string[]).includes(String(v))
    ? String(v)
    : loadEnv().AWS_DEFAULT_REGION;

export async function startQuickCreate(fd: FormData) {
  const a = await actor();
  const r = region(fd.get("region"));
  const { token } = await issueSetupToken({
    purpose: "aws_callback",
    issuedBy: a.userId,
    region: r,
    ttlMs: 15 * 60_000,
  });
  const env = loadEnv();
  return {
    ok: true as const,
    data: {
      url: buildQuickCreateUrl({
        region: r,
        templateUrl: env.CFN_TEMPLATE_URL,
        callbackUrl: `${env.APP_URL}/api/setup/aws/callback`,
        callbackToken: token,
        stackName: "sendsprite-connect",
      }),
    },
  };
}
export async function detectRole(fd: FormData) {
  const a = await actor();
  const res = await aws.detectInstanceRole(region(fd.get("region")), a);
  revalidatePath("/setup");
  return res;
}
export async function connectKeys(fd: FormData) {
  const a = await actor();
  const res = await aws.connectWithKeys(
    {
      accessKeyId: fd.get("accessKeyId"),
      secretAccessKey: fd.get("secretAccessKey"),
      region: region(fd.get("region")),
    },
    a,
  );
  revalidatePath("/setup");
  return res;
}
export async function requestProduction(fd: FormData) {
  const a = await actor();
  const res = await aws.requestProductionAccess(
    {
      websiteUrl: fd.get("websiteUrl"),
      mailType: fd.get("mailType"),
      useCase: fd.get("useCase"),
      contactEmail: fd.get("contactEmail") || undefined,
    },
    a,
  );
  revalidatePath("/setup");
  return res;
}
export async function refreshAccount() {
  const a = await actor();
  const res = await aws.refreshSesAccount(a);
  revalidatePath("/setup");
  return res;
}
export async function connectCloudflareAction(fd: FormData) {
  const a = await actor();
  const res = await cf.connectCloudflare(String(fd.get("token") ?? ""), a);
  revalidatePath("/setup");
  return res;
}
export async function disconnectAws() {
  const a = await actor();
  const res = await aws.disconnectAws(a);
  revalidatePath("/setup");
  return res;
}
export async function disconnectCloudflareAction() {
  const a = await actor();
  const res = await cf.disconnectCloudflare(a);
  revalidatePath("/setup");
  return res;
}
export async function finishSetup() {
  const a = await actor();
  await updateInstanceSettings({ setupCompleted: true }, a);
  revalidatePath("/app", "layout");
  return { ok: true as const, data: undefined };
}
```

- [x] **Step 3: Wizard page and steps**

`apps/web/src/app/setup/page.tsx` (server): `requireOwner()`, load settings, compute `step` from `?step=` (default: aws if not connected, else production if sandbox, else cloudflare, else done), render `<SetupWizard settings={plain} step={step} regions={SES_REGIONS} defaultRegion={env.AWS_DEFAULT_REGION} />` inside the auth layout style (`glass-strong` card, max-w-2xl, step indicator with `num-stamp`). Pass only serialisable, non-secret fields (`awsMode, awsRegion, awsAccountId, sesAccountStatus, sesReviewStatus, sesDailyQuota, sesMaxSendRate, cloudflareConnectedAt, cloudflareAccountName, setupCompleted`).

`SetupWizard.tsx` (client): renders the step component; nav links to `?step=`.

`steps/AwsStep.tsx` (client) — three panels:

1. **Detect instance role**: region `Select` + `Button` "Use this server's AWS role" → `detectRole`; on `ok:false` show the message inline ("No role found — that's normal off AWS").
2. **One-click (recommended)**: region `Select`, `Button` "Open AWS console" → `startQuickCreate` → `window.open(url, "_blank")`, then start polling `GET /api/setup/aws/status` every 3 s (stop when `connected` or `pendingToken===false`), showing `Spinner` + "Waiting for CloudFormation… click Create stack in the tab we opened. Acknowledge the IAM capability checkbox." On connected → `router.refresh()`.
3. **Manual**: access key, secret (`type=password`), region → `connectKeys`.
   When connected: show account id, region, mode `Badge`, "Disconnect" (confirm) and "Continue".

`steps/ProductionStep.tsx` — shows `StatusDot` for sandbox/requested/production with quota; if sandbox: form (website URL, mail type select, use case textarea min 20, contact email) → `requestProduction`; if requested: "AWS is reviewing (usually < 24 h)" + "Check now" → `refreshAccount`; "Skip for now" always available.

`steps/CloudflareStep.tsx` — instruction card: link `https://dash.cloudflare.com/profile/api-tokens` (`target=_blank`), bullet list _Zone → Zone → Read_, _Zone → DNS → Edit_, zone scope; token `Input type=password` → `connectCloudflareAction`; on success list zone names; "Skip (I'll add DNS records manually)".

`steps/DoneStep.tsx` — summary + `Button` "Go to dashboard" → `finishSetup` then `router.push("/app")`.

Every form uses `useActionState` + `pending` disable + `role="alert"` errors, same as Phase 1's `RenameForm`.

- [x] **Step 4: Typecheck and manual run**

Run: `cd apps/web && bun run typecheck` → clean. Dev check (`bun run db:dev` + `bun run dev -- -p 3001`): first owner is redirected `/app` → `/setup`; manual path with fake keys shows the AWS error inline; "Skip" through to Done; `/app` renders after `finishSetup`. Kill background processes.

- [x] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): setup wizard — AWS (role/one-click/manual), SES production access, Cloudflare"
```

**Review follow-ups (applied with the Task 14 commit):**

- `SES_REGIONS` lives in `@/lib/aws/regions` (not `clients`). The waiting page is `app/(onboarding)/waiting/page.tsx` (outside `/app`, as Step 1 concluded); `listOwnerEmails()` in `lib/team.ts` feeds it.
- `STEPS`, `Step`, `WizardSettings`, `WizardProps` live in `app/setup/types.ts`, a plain module: a value exported from a `"use client"` file arrives in a server component as a client reference (`STEPS.includes is not a function`).
- `startQuickCreate` refuses (`ok:false`) when `APP_URL` is not https (template `CallbackUrl` allows only `^https://`); the panel also disables the button via the `oneClickAvailable` prop. The popup is opened synchronously on click and given its URL after the action resolves; when blocked, the link is rendered.
- `AwsStep` fetches `/api/setup/aws/status` once on mount (resumes polling on a pending token, surfaces `lastFailure.reason`) and every 3 s while pending; connect `warning`s render as amber notices. Shared `Heading/Panel/Alert/Notice` are in `steps/shared.tsx`.

**Review follow-ups (wizard polish commit, after Task 15):**

- Skipping AWS during setup is by design: the waiting page copy no longer claims an AWS connection is required, and `DoneStep` shows an amber notice ("AWS isn't connected yet — connect it from Settings → Instance before adding domains.") when `awsMode === "none"`; `finishSetup` is unchanged.
- `QuickCreate` lives in `steps/QuickCreate.tsx`, calls `router.refresh()` itself, sets `w.opener = null`, and stops polling on HTTP 401 ("Session expired — reload the page."), after 20 consecutive failed fetches, when `pendingToken` is false, or once `expiresAt` has passed ("The one-click link expired; open a new one.").
- `startQuickCreate` calls `revokePendingSetupTokens("aws_callback", userId)` before issuing, so one link is live per owner. `region()` in `actions.ts` returns `ok:false` "Unsupported SES region." instead of substituting the default.
- `listOwnerEmails(userId)` returns owners of the caller's teams, falling back to every owner only when that set is empty (`tests/integration/session.test.ts`).
- a11y: step `Heading` is an `<h2>` (the setup page owns an sr-only `<h1>`, so the instance settings tab no longer has three `<h1>`s); the step list is wrapped in `<nav aria-label="Setup steps">`.
- The callback's connect `warning` is only ever returned to the Lambda; the route `console.warn`s it. Persisting it for the wizard was judged YAGNI.

---

### Task 15: Instance settings tab + domains UI

**Files:**

- Create: `apps/web/src/app/app/settings/instance/page.tsx`, `apps/web/src/app/app/domains/page.tsx`, `apps/web/src/app/app/domains/new/page.tsx`, `apps/web/src/app/app/domains/[id]/page.tsx`, `apps/web/src/app/app/domains/actions.ts`, `apps/web/src/app/app/domains/DomainForm.tsx`, `apps/web/src/app/app/domains/RecordsTable.tsx`, `apps/web/src/app/app/domains/DomainActions.tsx`
- Modify: `apps/web/src/app/app/settings/page.tsx` (link to Instance tab for owners), `apps/web/src/app/app/page.tsx` (checklist)

- [x] **Step 1: Instance tab**

`settings/instance/page.tsx`: `requireOwner()`; reuse `AwsStep`, `ProductionStep`, `CloudflareStep` in three `Card`s with the same actions (import from `@/app/setup/actions`), plus a "Signup mode" select (`open|invite|closed|auto`) and "Landing page enabled" toggle written via a new `updateInstanceAction(fd)` in `setup/actions.ts` (`updateInstanceSettings({ signupMode, landingEnabled }, a)`), and "Retention days" number. Add a "Instance" link in `settings/page.tsx` when `ctx.role === "owner"`.

- [x] **Step 2: Domain actions**

`domains/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireTeam } from "@/lib/session";
import { requestMeta } from "@/lib/audit";
import * as domains from "@/services/domains";
import { enqueue } from "@/jobs/handlers/domain-provision";
export type { Result } from "@/lib/result";

async function actor() {
  const ctx = await requireTeam();
  return {
    userId: ctx.userId,
    teamId: ctx.team.id,
    teamName: ctx.team.name,
    role: ctx.role,
    meta: requestMeta(await headers()),
  };
}

export async function createDomain(fd: FormData) {
  const res = await domains.createDomain(
    await actor(),
    { name: fd.get("name") },
    { enqueue },
  );
  if (res.ok) revalidatePath("/app/domains");
  return res;
}
export async function reverifyDomain(id: string) {
  const res = await domains.reverifyDomain(await actor(), id, { enqueue });
  revalidatePath(`/app/domains/${id}`);
  return res;
}
export async function deleteDomain(id: string) {
  const res = await domains.deleteDomain(await actor(), id, {});
  if (res.ok) revalidatePath("/app/domains");
  return res;
}
```

Note: importing `@/jobs/handlers/domain-provision` from a route bundle registers the queue in that bundle too — harmless (registry is on `globalThis`; `startWorker` only runs in instrumentation).

- [x] **Step 3: Pages**

- `domains/page.tsx`: `requireTeam()`, `listDomains(team.id)`; `EmptyState` when none ("Add your first sending domain"); otherwise a table: name, `StatusDot` (pending→`pending`, verified→`ok`, failed→`error`), DNS mode `Badge` (auto/manual), region, last checked, link to detail. Button "Add domain" → `/app/domains/new`. If `awsMode==="none"`, show a banner linking owners to `/app/settings/instance`.
- `domains/new/page.tsx` + `DomainForm.tsx` (client): single `Input` "mail.example.com", helper text on subdomain recommendation; on success `router.push(`/app/domains/${id}`)`. Show whether Cloudflare auto mode will apply (server passes `hasCloudflare`).
- `domains/[id]/page.tsx`: `getDomain(team.id, id)` or `notFound()`; header with status, mode, `lastError` banner; `RecordsTable` (kind label, type, name, value with `CopyField`-style `select-all` code, priority, ✓/✗ from `ok`) — explain manual mode ("Add these at your DNS provider; we re-check every 2 minutes for 72 h"); `DomainActions` (client): "Re-verify" (transition, disabled while pending), "Delete" (confirm) → `router.push("/app/domains")`. Auto-refresh: client `useEffect` `router.refresh()` every 15 s while status is `pending` (SSE arrives in Phase 3).
- `app/page.tsx` checklist: "Add a sending domain" done when `listDomains(team.id).some(d => d.status === "verified")`; link each step to its page.

Add a `CopyField` primitive in `components/ui/CopyField.tsx` (client: `navigator.clipboard.writeText`, "Copied" state) — the spec lists it and the records table needs it.

- [x] **Step 4: Typecheck, manual run, commit**

Run: `cd apps/web && bun run typecheck` → clean. Dev check: with AWS not connected, `/app/domains/new` shows the connect banner and the service returns the "Connect AWS first" error. Kill processes.

```bash
git add apps/web
git commit -m "feat(web): instance settings tab, domains list/new/detail with live record checks"
```

**Review follow-ups (applied after the Task 15 commit):**

- Steps take `mode: "wizard" | "settings"` (`WizardProps`); the Instance tab passes `settings` to hide Continue/Skip. `updateInstanceAction` returns the first zod issue message; `signupMode: "auto"` stores `null`.
- Landing page: `app/page.tsx` reads `instance_settings.landing_enabled ?? env.LANDING_ENABLED` (the DB value wins once set; there is no env "override" because `LANDING_ENABLED` defaults to true). Retention days is stored now and consumed by the Phase 3 retention job.
- `reverifyDomain` refuses (`ok:false`, "Provisioning hasn't finished yet.") while `dkimTokens` is empty; the detail page passes `provisioned` and disables Re-verify with a "Waiting for provisioning…" title.
- Domain UI is gated by `can(role, "domains.manage")`: no "Add domain" button, `/app/domains/new` redirects to the list, and `DomainActions` is hidden (records stay visible). `/app/domains/new` shows the AWS-not-connected notice above the form.
- `formatWhen` lives in `lib/format.ts`; `DomainActions` skips `router.refresh()` while the tab is hidden; record ✓/✗ glyphs carry sr-only "found"/"not found" text.

---

### Task 16: E2E — setup wizard (manual path, mocked AWS) and domains page

**Files:**

- Create: `apps/web/tests/e2e/setup.spec.ts`
- Modify: `apps/web/playwright.config.ts` (webServer env `AWS_E2E_MOCK=1`), `apps/web/src/lib/aws/clients.ts` (mock seam)

- [x] **Step 1: Mock seam**

E2E runs a real Next server, so AWS calls need an in-process fake. In `clients.ts`, when `process.env.AWS_E2E_MOCK === "1"`, return clients whose `send()` resolves canned responses (`GetCallerIdentity` → account `111111111111`; `GetAccount` → sandbox; `CreateConfigurationSet*`/`CreateTopic`/`Subscribe` → ok; `CreateEmailIdentity` → tokens `e1,e2,e3`; `GetEmailIdentity` → PENDING). Implement as a small `FakeClient` class with a `send(cmd)` switch on `cmd.constructor.name`, guarded so it can never activate in production (`NODE_ENV !== "production"` AND the env var).

- [x] **Step 2: Spec**

`tests/e2e/setup.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("owner completes setup via manual keys, adds a domain, sees records", async ({
  page,
}) => {
  const email = `owner-${Date.now()}@example.com`;
  await page.goto("/signup");
  await page.fill("#name", "Owner");
  await page.fill("#email", email);
  await page.fill("#password", "correct-horse-battery");
  await page.click("button[type=submit]");
  await expect(page.getByRole("button", { name: "Create team" })).toBeVisible();
  await page.fill("#name", "Acme");
  await page.click("button[type=submit]");
  await expect(page).toHaveURL(/\/setup/);
  await page.getByRole("button", { name: /paste keys manually/i }).click();
  await page.fill("#accessKeyId", "AKIAE2EEXAMPLE0001");
  await page.fill("#secretAccessKey", "e2e-secret-e2e-secret");
  await page.getByRole("button", { name: /connect/i }).click();
  await expect(page.getByText("111111111111")).toBeVisible();
  await page.getByRole("link", { name: /continue/i }).click();
  await page.getByRole("button", { name: /skip for now/i }).click(); // production
  await page.getByRole("button", { name: /skip/i }).click(); // cloudflare
  await page.getByRole("button", { name: /go to dashboard/i }).click();
  await expect(page).toHaveURL(/\/app$/);
  await page.goto("/app/domains/new");
  await page.fill("#name", "mail.e2e-acme.com");
  await page.click("button[type=submit]");
  await expect(page).toHaveURL(/\/app\/domains\/dom_/);
  await expect(page.getByText("e1._domainkey.mail.e2e-acme.com")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("_dmarc.mail.e2e-acme.com")).toBeVisible();
});
```

`playwright.config.ts` webServer env: add `AWS_E2E_MOCK: "1"`, and `WORKER_MODE: "inline"` for this project (provisioning runs as a job). Use ids `#accessKeyId`, `#secretAccessKey`, `#name` in the forms accordingly.

- [x] **Step 3: Run, commit**

Run: `cd apps/web && bun run test:e2e` (db:dev running) → 2 passed.

```bash
git add apps/web
git commit -m "test(web): e2e setup wizard (manual AWS) and domain provisioning with mocked AWS"
```

**Review follow-ups (applied with the Task 16 commit):**

- The fake lives in `lib/aws/fake-client.ts` (`FakeAwsClient`, a `send()` switch on `cmd.constructor.name`; unhandled commands throw). `clients.ts` returns it from every factory only when `AWS_E2E_MOCK === "1"` **and** `NODE_ENV !== "production"`, cast to the SDK client type at the boundary. `playwright.config.ts` sets `AWS_E2E_MOCK: "1"` and `WORKER_MODE: "inline"` unconditionally in the webServer env, so `ci.yml` needs no new variable.
- A successful manual-keys connect on `/setup` calls `router.refresh()` without a `step` param, so the server advances to the production step itself: there is no "Continue" link to click. The spec asserts the production heading and the "sandbox" status, then "Skip for now" → "Skip" → "Go to dashboard"; the account id is asserted on the Done step ("AWS connected · 111111111111 · us-east-1").
- The spec does not assume a fresh instance: when signup lands in the app (setup already completed, e.g. the local dev database) it connects AWS on `/app/settings/instance` with the same ids, or keeps an existing connection (the fake ignores stored keys). The domain and team names carry a per-run suffix (instance-wide uniqueness), and the test deletes the domain through the UI at the end (fake `DeleteEmailIdentity`).
- The Phase 1 smoke spec expects an open dashboard, which an empty database no longer offers until the wizard has run, and two specs creating teams in parallel raced on the slug. `playwright.config.ts` now has two projects: `setup` (`setup.spec.ts`) and `app` (everything else, `dependencies: ["setup"]`), so the wizard completes first and the smoke spec runs after it.
- Records appear after the provision job runs on the inline worker; the spec reloads in a loop (30 s ceiling) rather than waiting on the page's 15 s refresh, then asserts Re-verify is enabled and the status is `pending` (DNS checks against public resolvers find nothing for the made-up domain, as intended).

---

### Task 17: Docs — README, maintainer notes, plan/spec sync

**Files:**

- Modify: `README.md`, `docs/superpowers/specs/2026-08-24-sendsprite-design.md` (§6 note on S3 template hosting), `infra/aws/README.md` (create)

- [ ] **Step 1: infra/aws/README.md**

Explain: what the stack creates, the callback flow, why quick-create needs S3, how to publish (`aws s3 mb s3://sendsprite-cfn --region us-east-1`, bucket policy for public `GetObject` on `/*`, `aws s3 cp … --acl public-read`, then uncomment the CI publish steps), how self-hosters override with `CFN_TEMPLATE_URL`, and how to revoke (delete the stack).

- [ ] **Step 2: README**

Add a "Connect AWS & Cloudflare" section (three AWS paths, sandbox caveat, Cloudflare token permissions, manual DNS mode), env table rows for `CFN_TEMPLATE_URL`, `AWS_DEFAULT_REGION`, and the roadmap line "Phase 2: done".

- [ ] **Step 3: Spec note**

In spec §6.1 append: "Quick-create only accepts S3 template URLs; the template is published to a public bucket (`CFN_TEMPLATE_URL`)." and in §7 note REST domains endpoints ship in Phase 3.

- [ ] **Step 4: Commit**

```bash
git add README.md docs infra
git commit -m "docs: Phase 2 provisioning — AWS/Cloudflare connect, template publishing, env"
```

---

## Self-review

**Spec coverage (§6):** wizard steps 1–5 → T14; instance-role detection → T7/T14; one-click CFN + callback + polling → T5/T6/T8/T14; manual keys → T7/T14; post-connect config set / SNS topic / subscription / GetAccount → T7/T9; production access request + hourly recheck → T7/T10/T14; Cloudflare deep link + verify + zones → T11/T14; re-enterable from Settings → T15; domains add (auto/manual), provision steps 1–5, per-record status, forced verify, delete cleanup, instance-wide uniqueness → T12/T13/T15. §5 `domains` columns → T4 (adds `verify_until`, `last_error`, `created_by`; `cloudflareId` lives inside `expected_records`). Openers 1–7 → T1–T3 (heartbeat persistence #6 deferred to Phase 3 where health gets its worker signal from real queues; noted in T10 comment — add this as a Phase 3 opener).

**Placeholder scan:** none. The two "verify against installed types" instructions (organization hook signatures in T3, pg-boss `send`/`createQueue` option shapes in T1/T13) are explicit checks with the file to open, not deferred work.

**Type consistency:** `Result` moves to `@/lib/result` in T7 and is imported from there in T11/T13/T14/T15 (T3's `services/team.ts` keeps re-exporting it). `Actor { userId, meta? }` (aws/cloudflare services) vs `TeamActor` (domains) — distinct on purpose: instance-level vs team-level. `Enqueue` type defined in T13 and implemented in T13 handlers, used by T15 actions. `ExpectedRecord` defined in T4 schema, produced by T12, consumed by T13/T15. `SES_REGIONS` from T5 used in T14. `requireOwner` from T14 used in T15.
