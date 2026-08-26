# Org-Level AWS & Cloudflare Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the AWS account and the Cloudflare OAuth grant off the `instance_settings` singleton and onto the team, so every org connects and pays for its own cloud accounts.

**Architecture:** Two narrow tables (`team_aws`, `team_cloudflare`) keyed by `organization.id` replace the singleton's cloud columns; the presence of a row _is_ the connection, so `awsMode = "none"` disappears. `resolveAwsContext(teamId)` is the one signature change that propagates through sending, domains and the SNS webhook. SES events arrive on a team-scoped path `/api/webhooks/ses/[teamId]` and are authorised by path **and** topic ARN, and `ingestSesEvent` gains a team predicate so one tenant cannot write another's timeline. AWS resource names carry a sanitised org slug because two orgs may point at one AWS account.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM 0.45 on Postgres, AWS SDK v3 (SESv2, SNS, STS), `aws-sdk-client-mock`, Zod 4, Vitest 4, Playwright.

This is **phase 9 of 9** and depends on phase 8 (`2026-08-26-phase-8-instance-admin.md`) being merged: it assumes `requireInstanceAdmin` exists and that the operator form already lives at `/app/admin`.

**Spec:** `docs/superpowers/specs/2026-08-26-org-level-connections-design.md`

---

## Migration numbering

The spec calls these migrations 0019/0020/0021. Phase 8 consumes 0019 and
0020, so here they are **0021** (additive), **0022** (data move) and **0023**
(destructive). The split and the ordering are exactly as the spec describes;
only the numbers shift.

---

## Ordering constraint

The schema change breaks type-checking across the app until every consumer is
updated, so tasks 2–12 are **one continuous red-to-green run**: `bun run
typecheck` is expected to fail from task 2 until task 12. Each task still
commits, and each task's own tests pass — but do not treat a failing
`typecheck` between them as a defect. Task 12 is where the tree goes green
again, and no task after 12 may leave it red.

---

## File Structure

| File                                                   | Responsibility                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| `src/lib/aws/naming.ts` _(new)_                        | Pure: sanitise a slug, derive stack/config-set/topic names        |
| `src/lib/session.ts`                                   | `requireOwner` → `requireTeamAdmin` (owner or admin, active team) |
| `src/db/schema/team-aws.ts` _(new)_                    | `team_aws` table                                                  |
| `src/db/schema/team-cloudflare.ts` _(new)_             | `team_cloudflare` table                                           |
| `src/db/schema/send-rate.ts`                           | `send_rate_state` → `team_send_rate`                              |
| `src/services/team-aws.ts` _(new)_                     | Read/write/disconnect the AWS connection + secrets                |
| `src/services/instance-settings.ts`                    | Slimmed to signup mode, landing page, retention ceiling           |
| `src/lib/aws/credentials.ts`                           | `resolveAwsContext(teamId)`                                       |
| `src/services/aws-connect.ts`                          | Connect/disconnect/refresh, team-scoped, slug-named resources     |
| `src/services/cloudflare-connect.ts`                   | OAuth + token storage, team-scoped                                |
| `src/app/api/webhooks/ses/[teamId]/route.ts` _(moved)_ | Team-scoped SNS ingress                                           |
| `src/services/ingest.ts`                               | Team-scoped event attribution                                     |
| `src/services/send-limits.ts`                          | Per-team bucket and per-team account quota                        |
| `src/app/app/settings/sending/*` _(moved)_             | Team connection page                                              |
| `tests/integration/helpers.ts`                         | `connectTeamAws` fixture                                          |

---

## Task 1: AWS resource naming

**Files:**

- Create: `apps/web/src/lib/aws/naming.ts`
- Create: `apps/web/tests/unit/aws-naming.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/unit/aws-naming.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  awsResourceSuffix,
  configSetName,
  stackName,
  topicName,
} from "@/lib/aws/naming";

describe("awsResourceSuffix", () => {
  it("lowercases and keeps legal characters", () => {
    expect(awsResourceSuffix("Acme-Corp")).toBe("acme-corp");
  });
  it("replaces illegal characters with a hyphen", () => {
    expect(awsResourceSuffix("Acme_Corp!!")).toBe("acme-corp");
  });
  it("collapses runs and trims edge hyphens", () => {
    expect(awsResourceSuffix("--a  b--")).toBe("a-b");
  });
  it("caps at 40 characters without a trailing hyphen", () => {
    const s = awsResourceSuffix("x".repeat(50));
    expect(s).toHaveLength(40);
    expect(s.endsWith("-")).toBe(false);
  });
  it("falls back when nothing legal survives", () => {
    expect(awsResourceSuffix("!!!")).toBe("team");
  });
});

describe("derived names", () => {
  it("builds all three from one suffix", () => {
    expect(stackName("Acme_Corp")).toBe("sendsprite-connect-acme-corp");
    expect(configSetName("Acme_Corp")).toBe("sendsprite-acme-corp");
    expect(topicName("Acme_Corp")).toBe("sendsprite-events-acme-corp");
  });
  it("produces a CloudFormation-legal stack name", () => {
    expect(stackName("9-lives")).toMatch(/^[A-Za-z][A-Za-z0-9-]*$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && bun run test -- aws-naming
```

Expected: FAIL — `Failed to resolve import "@/lib/aws/naming"`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/aws/naming.ts`:

```ts
/**
 * AWS resource names for one team.
 *
 * Nothing stops one person connecting two orgs to the **same** AWS account,
 * so these names cannot be constants. A shared configuration set is the
 * dangerous case: `CreateConfigurationSetEventDestination` takes its
 * `AlreadyExists` branch and *updates* the destination, silently repointing
 * one org's SES events at another org's SNS topic.
 *
 * The three services disagree on legal characters (CloudFormation stack
 * names are `[A-Za-z][A-Za-z0-9-]*`; SES configuration sets and SNS topics
 * also allow `_`), so one sanitiser governs all three and the strictest rule
 * wins. 40 characters leaves room under every limit once the prefixes are
 * added.
 *
 * Names are chosen once at connect time and persisted on `team_aws`. Slugs
 * are mutable — never re-derive a name for an existing connection or it will
 * address a configuration set that does not exist.
 */
const MAX = 40;

export function awsResourceSuffix(slug: string): string {
  const s = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX)
    .replace(/-$/, "");
  return s.length > 0 ? s : "team";
}

export const stackName = (slug: string) =>
  `sendsprite-connect-${awsResourceSuffix(slug)}`;
export const configSetName = (slug: string) =>
  `sendsprite-${awsResourceSuffix(slug)}`;
export const topicName = (slug: string) =>
  `sendsprite-events-${awsResourceSuffix(slug)}`;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && bun run test -- aws-naming
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd D:/Documents/Work/Mail
git add apps/web/src/lib/aws/naming.ts apps/web/tests/unit/aws-naming.test.ts
git commit -m "feat(aws): derive stack, config set and topic names from the org slug"
```

---

## Task 1b: The `requireTeamAdmin` gate

Every page and action in this phase gates on `requireTeamAdmin()`, so it has
to exist before task 5.

**Files:**

- Modify: `apps/web/src/lib/session.ts`
- Test: `apps/web/tests/integration/session.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/tests/integration/session.test.ts`, following that file's
existing stubbing of `next/navigation` and `@/lib/auth`:

```ts
it("requireTeamAdmin passes an owner", async () => {
  // stub resolveTeam to return role "owner"
  const { requireTeamAdmin } = await import("@/lib/session");
  const ctx = await requireTeamAdmin();
  expect(ctx.role).toBe("owner");
});

it("requireTeamAdmin passes an admin", async () => {
  // stub resolveTeam to return role "admin"
  const { requireTeamAdmin } = await import("@/lib/session");
  const ctx = await requireTeamAdmin();
  expect(ctx.role).toBe("admin");
});

it("requireTeamAdmin redirects a member to /app", async () => {
  // stub resolveTeam to return role "member"
  const { requireTeamAdmin } = await import("@/lib/session");
  await expect(requireTeamAdmin()).rejects.toThrow("NEXT_REDIRECT");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/web && bun run test:integration -- session
```

Expected: FAIL — `requireTeamAdmin is not a function`.

- [ ] **Step 3: Replace `requireOwner`**

In `apps/web/src/lib/session.ts`, replace `requireOwner` with:

```ts
/**
 * Connecting a cloud account for the team. Owner **or** admin: the billing
 * owner is often not the engineer who holds the AWS account. Scoped to the
 * *active* team — it no longer means "owner of any team", which was only ever
 * a stand-in for an instance operator while there was one AWS connection.
 * That meaning now lives in `requireInstanceAdmin`.
 */
export async function requireTeamAdmin(): Promise<TeamContext> {
  const ctx = await requireTeam();
  if (ctx.role !== "owner" && ctx.role !== "admin") redirect("/app");
  return ctx;
}
```

- [ ] **Step 4: Point the old callers at it**

```bash
cd apps/web && grep -rn "requireOwner" src/
```

Replace every hit with `requireTeamAdmin`. There should be no `requireOwner`
left anywhere when this returns nothing.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/web && bun run test:integration -- session
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd D:/Documents/Work/Mail
git add apps/web/src/lib/session.ts apps/web/src/app apps/web/tests/integration/session.test.ts
git commit -m "feat(auth): replace requireOwner with a team-scoped requireTeamAdmin"
```

---

## Task 2: The new tables

**Files:**

- Create: `apps/web/src/db/schema/team-aws.ts`
- Create: `apps/web/src/db/schema/team-cloudflare.ts`
- Modify: `apps/web/src/db/schema/send-rate.ts`
- Modify: `apps/web/src/db/schema/setup-tokens.ts`
- Modify: `apps/web/src/db/schema/team-settings.ts`
- Modify: `apps/web/src/db/schema/index.ts`
- Create: `apps/web/drizzle/0021_team_connections.sql`

- [ ] **Step 1: Create `team_aws`**

Create `apps/web/src/db/schema/team-aws.ts`:

```ts
import {
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";

/**
 * One team's AWS connection. **The row's existence is the connection** —
 * there is no `mode: "none"`, and `getTeamAws` returning null is what every
 * "is AWS connected?" check reads.
 *
 * The old `instance_role` mode is gone: it meant "whatever the SDK's default
 * chain finds on this host", and one process has exactly one ambient
 * identity, so it can never serve more than one tenant. `keys` was then the
 * only mode left, which is why there is no mode column and why the key
 * columns are `notNull`.
 *
 * `configSet` and `snsTopicArn` hold the names actually created in the
 * tenant's account. They are derived from the org slug at connect time and
 * never re-derived: slugs are mutable.
 *
 * Encrypted columns end in `_enc`, matching the project-wide convention.
 */
export const teamAws = pgTable("team_aws", {
  teamId: text("team_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  region: text("region").notNull(),
  accessKeyEnc: text("access_key_enc").notNull(),
  secretEnc: text("secret_enc").notNull(),
  accountId: text("account_id"),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull(),
  configSet: text("config_set").notNull(),
  /** Unique: two teams sharing one topic would cross-deliver events. */
  snsTopicArn: text("sns_topic_arn").unique(),
  snsSubscriptionArn: text("sns_subscription_arn"),
  sesAccountStatus: text("ses_account_status", {
    enum: ["sandbox", "requested", "production"],
  }),
  sesReviewStatus: text("ses_review_status", {
    enum: ["PENDING", "GRANTED", "DENIED", "FAILED"],
  }),
  sesDailyQuota: integer("ses_daily_quota"),
  sesMaxSendRate: doublePrecision("ses_max_send_rate"),
  sesLastCheckedAt: timestamp("ses_last_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // `$onUpdate` does not fire on `onConflictDoUpdate`; upserts set this
  // explicitly (same note as team-settings.ts).
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
```

- [ ] **Step 2: Create `team_cloudflare`**

Create `apps/web/src/db/schema/team-cloudflare.ts`:

```ts
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./auth";

/**
 * One team's Cloudflare OAuth grant (Manage Account → OAuth clients).
 * Separate from `team_aws` so disconnecting either is a row delete rather
 * than nulling half a wide row, and so the send path never reads Cloudflare
 * columns it does not use.
 */
export const teamCloudflare = pgTable("team_cloudflare", {
  teamId: text("team_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  accountName: text("account_name"),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
```

- [ ] **Step 3: Re-key the send-rate bucket**

Replace `apps/web/src/db/schema/send-rate.ts` with:

```ts
import { doublePrecision, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./auth";

/**
 * Token bucket for one team's SES `MaxSendRate`. It was a singleton while
 * the whole instance shared one AWS account; per tenant it must be per team,
 * and that also removes a real coupling — one team's volume could drain the
 * bucket every other team drew from.
 */
export const teamSendRate = pgTable("team_send_rate", {
  teamId: text("team_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  tokens: doublePrecision("tokens").notNull().default(0),
  refilledAt: timestamp("refilled_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

- [ ] **Step 4: Add `teamId` to setup tokens and `setupCompleted` to team settings**

In `apps/web/src/db/schema/setup-tokens.ts`, after `issuedBy`:

```ts
  /**
   * Which team the CloudFormation stack is connecting. Read off the token by
   * the callback, so a stack created for one team can never connect into
   * another even with a valid token.
   */
  teamId: text("team_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
```

with `import { organization } from "./auth";` added.

In `apps/web/src/db/schema/team-settings.ts`, after `retentionDays`:

```ts
  /** Set when this team finishes the connect wizard; gates /app. */
  setupCompleted: boolean("setup_completed").notNull().default(false),
```

- [ ] **Step 5: Export the new tables**

In `apps/web/src/db/schema/index.ts`, replace the `./send-rate` line and add
the two new modules:

```ts
export * from "./team-aws";
export * from "./team-cloudflare";
export * from "./send-rate";
```

- [ ] **Step 6: Generate the additive migration**

```bash
cd apps/web && bun run db:generate --name team_connections
```

Expected: `drizzle/0021_team_connections.sql` creating `team_aws`,
`team_cloudflare`, `team_send_rate`, and adding `setup_tokens.team_id` and
`team_settings.setup_completed`.

**Check the generated SQL before continuing.** It must not contain a `DROP`
of `send_rate_state` or of any `instance_settings` column — those belong in
task 12's destructive migration. If drizzle-kit produced drops, delete those
statements from the file by hand; a diff that both drops and adds on one
table is also what makes drizzle-kit prompt for a TTY.

- [ ] **Step 7: Verify the migration applies**

```bash
cd apps/web && bun run test:integration -- db
```

Expected: PASS — `_pg.ts` runs every migration on a fresh database, so a
green `db.test.ts` means the SQL is valid.

- [ ] **Step 8: Commit**

```bash
cd D:/Documents/Work/Mail
git add apps/web/src/db apps/web/drizzle/
git commit -m "feat(schema): add team_aws, team_cloudflare and team_send_rate"
```

---

## Task 3: `services/team-aws.ts`

**Files:**

- Create: `apps/web/src/services/team-aws.ts`
- Create: `apps/web/tests/integration/team-aws.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/integration/team-aws.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
let teamId: string;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  teamId = (await seedTeamWithKey()).team.id;
});
afterAll(async () => {
  await pg.stop();
});

const connect = {
  region: "us-east-1",
  accessKey: "AKIAEXAMPLE",
  secret: "s3cr3t",
  configSet: "sendsprite-acme",
  connectedAt: new Date(),
};

describe("team aws", () => {
  it("is null before a connection", async () => {
    const { getTeamAws } = await import("@/services/team-aws");
    expect(await getTeamAws(teamId)).toBeNull();
  });

  it("encrypts the keys at rest and decrypts on read", async () => {
    const { updateTeamAws, getTeamAwsSecrets } =
      await import("@/services/team-aws");
    const row = await updateTeamAws(teamId, connect);
    expect(row.accessKeyEnc).toMatch(/^v1\./);
    expect(row.accessKeyEnc).not.toContain("AKIA");
    expect(await getTeamAwsSecrets(teamId)).toMatchObject({
      accessKey: "AKIAEXAMPLE",
      secret: "s3cr3t",
    });
  });

  it("leaves the keys untouched on a plain patch", async () => {
    const { updateTeamAws, getTeamAws } = await import("@/services/team-aws");
    const before = await getTeamAws(teamId);
    const after = await updateTeamAws(teamId, { sesDailyQuota: 200 });
    expect(after.sesDailyQuota).toBe(200);
    expect(after.accessKeyEnc).toBe(before?.accessKeyEnc);
  });

  it("scopes rows to their team", async () => {
    const other = (await seedTeamWithKey()).team.id;
    const { getTeamAws } = await import("@/services/team-aws");
    expect(await getTeamAws(other)).toBeNull();
  });

  it("writes a team-scoped audit row", async () => {
    const { updateTeamAws } = await import("@/services/team-aws");
    await updateTeamAws(
      teamId,
      { sesDailyQuota: 300 },
      { userId: "u_a", meta: { ip: "10.0.0.1", userAgent: "vitest" } },
      { action: "aws.connect" },
    );
    const { auditLog } = await import("@/db/schema");
    const rows = await pg.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "aws.connect"));
    expect(rows.at(-1)).toMatchObject({ teamId, actorUserId: "u_a" });
  });

  it("disconnect deletes the row", async () => {
    const { disconnectTeamAws, getTeamAws } =
      await import("@/services/team-aws");
    await disconnectTeamAws(teamId, { userId: "u_a" });
    expect(await getTeamAws(teamId)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && bun run test:integration -- team-aws
```

Expected: FAIL — `Failed to resolve import "@/services/team-aws"`.

- [ ] **Step 3: Write the service**

Create `apps/web/src/services/team-aws.ts`. Port the encryption, audit-diff
and redaction behaviour from `services/instance-settings.ts` verbatim — same
`getCipher()`, same `computeDiff`, same ciphertext-compared-so-a-rotation-shows
rule — changing only the key from `id = 1` to `team_id`:

```ts
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { teamAws } from "@/db/schema";
import { computeDiff, recordAudit, type RequestMeta } from "@/lib/audit";
import { getCipher } from "@/lib/crypto";

export type TeamAws = typeof teamAws.$inferSelect;

export interface AwsActor {
  userId: string;
  meta?: RequestMeta;
}

/** Request-scoped so a layout and its page share one query. */
export const getTeamAws = cache(
  async (teamId: string): Promise<TeamAws | null> => {
    const [row] = await db()
      .select()
      .from(teamAws)
      .where(eq(teamAws.teamId, teamId))
      .limit(1);
    return row ?? null;
  },
);

/** Plain columns only: the key columns are written through `Secrets`. */
type Plain = Partial<
  Omit<
    TeamAws,
    "teamId" | "createdAt" | "updatedAt" | "accessKeyEnc" | "secretEnc"
  >
>;
type Secrets = { accessKey?: string; secret?: string };

/**
 * Row as it appears in the audit diff: bookkeeping columns dropped, secret
 * columns compared as ciphertext so a rotation still registers. `computeDiff`
 * redacts them by key name, so plaintext never reaches the log.
 */
function auditView(row: TeamAws | null): Record<string, unknown> {
  if (!row) return {};
  const view: Record<string, unknown> = { ...row };
  for (const col of ["teamId", "createdAt", "updatedAt"]) delete view[col];
  return view;
}

/**
 * Upsert one team's connection. An insert needs the `notNull` columns
 * (`region`, both keys, `configSet`, `connectedAt`); a patch on an existing
 * row may omit them.
 */
export async function updateTeamAws(
  teamId: string,
  patch: Plain & Secrets,
  actor?: AwsActor,
  opts: { audit?: boolean; action?: string } = {},
): Promise<TeamAws> {
  const before = await getTeamAws(teamId);
  const { accessKey, secret, ...plain } = patch;
  const c = getCipher();
  const enc = {
    ...(accessKey !== undefined && { accessKeyEnc: c.encrypt(accessKey) }),
    ...(secret !== undefined && { secretEnc: c.encrypt(secret) }),
  };
  const set = { ...plain, ...enc, updatedAt: new Date() };
  const [row] = await db()
    .insert(teamAws)
    .values({ teamId, ...(set as typeof teamAws.$inferInsert) })
    .onConflictDoUpdate({ target: teamAws.teamId, set })
    .returning();
  if (!row) throw new Error("team_aws upsert returned no row");
  if (opts.audit === false) return row;
  await recordAudit({
    teamId,
    actorUserId: actor?.userId ?? null,
    action: opts.action ?? "aws.update",
    targetType: "team_aws",
    targetId: teamId,
    diff: computeDiff(auditView(before), auditView(row)),
    ...actor?.meta,
  });
  return row;
}

export async function getTeamAwsSecrets(
  teamId: string,
): Promise<{ accessKey: string; secret: string } | null> {
  const row = await getTeamAws(teamId);
  if (!row) return null;
  const c = getCipher();
  return {
    accessKey: c.decrypt(row.accessKeyEnc),
    secret: c.decrypt(row.secretEnc),
  };
}

/** Disconnecting is a row delete: existence of the row is the connection. */
export async function disconnectTeamAws(
  teamId: string,
  actor?: AwsActor,
): Promise<void> {
  const before = await getTeamAws(teamId);
  if (!before) return;
  await db().delete(teamAws).where(eq(teamAws.teamId, teamId));
  await recordAudit({
    teamId,
    actorUserId: actor?.userId ?? null,
    action: "aws.disconnect",
    targetType: "team_aws",
    targetId: teamId,
    diff: computeDiff(auditView(before), {}),
    ...actor?.meta,
  });
}
```

Note `getTeamAws` is wrapped in `React.cache`, which memoises per argument
within a request — after a write, call it again only outside the cached
window or read the returned row, exactly as `instance-settings.ts` does.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && bun run test:integration -- team-aws
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd D:/Documents/Work/Mail
git add apps/web/src/services/team-aws.ts apps/web/tests/integration/team-aws.test.ts
git commit -m "feat(aws): add team-scoped connection service"
```

---

## Task 4: `resolveAwsContext(teamId)`

**Files:**

- Modify: `apps/web/src/lib/aws/credentials.ts`

- [ ] **Step 1: Rewrite the resolver**

Replace the body of `apps/web/src/lib/aws/credentials.ts` below the
`AwsCredentials` type:

```ts
export interface AwsContext {
  region: string;
  credentials: AwsCredentials;
}

/**
 * The team's stored (encrypted) access key and secret. There is no longer a
 * credential-free mode: `instance_role` meant the SDK's default chain, which
 * is one ambient identity per process and therefore single-tenant. Callers
 * must check `getTeamAws(teamId)` first; this throws rather than silently
 * falling back to whatever credentials the host happens to carry, which
 * under multi-tenancy would mean sending from the wrong account.
 */
export async function resolveAwsContext(teamId: string): Promise<AwsContext> {
  const row = await getTeamAws(teamId);
  if (!row) throw new Error("AWS is not connected for this team");
  const sec = await getTeamAwsSecrets(teamId);
  if (!sec) throw new Error("AWS keys missing");
  return {
    region: row.region,
    credentials: {
      accessKeyId: sec.accessKey,
      secretAccessKey: sec.secret,
    },
  };
}
```

Replace the imports with:

```ts
import { getTeamAws, getTeamAwsSecrets } from "@/services/team-aws";
```

- [ ] **Step 2: Commit**

`typecheck` is expected to fail here and stay failing until task 12; that is
the ordering constraint at the top of this plan.

```bash
cd D:/Documents/Work/Mail
git add apps/web/src/lib/aws/credentials.ts
git commit -m "refactor(aws): resolve credentials per team"
```

---

## Task 5: Team-scoped connect, refresh and disconnect

**Files:**

- Modify: `apps/web/src/services/aws-connect.ts`
- Test: `apps/web/tests/integration/aws-connect.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/web/tests/integration/aws-connect.test.ts`, keeping the file's
existing `aws-sdk-client-mock` setup:

```ts
it("names the config set and topic from the org slug", async () => {
  const { connectWithKeys } = await import("@/services/aws-connect");
  const res = await connectWithKeys(team.id, "acme-corp", {
    accessKeyId: "AKIAEXAMPLE00000",
    secretAccessKey: "s".repeat(20),
    region: "us-east-1",
  });
  expect(res.ok).toBe(true);
  const { getTeamAws } = await import("@/services/team-aws");
  const row = await getTeamAws(team.id);
  expect(row?.configSet).toBe("sendsprite-acme-corp");
  expect(
    snsMock.commandCalls(CreateTopicCommand)[0]?.args[0].input,
  ).toMatchObject({ Name: "sendsprite-events-acme-corp" });
});

it("subscribes the team's own webhook path", async () => {
  const call = snsMock.commandCalls(SubscribeCommand)[0]?.args[0].input;
  expect(call?.Endpoint).toBe(
    `${process.env.APP_URL}/api/webhooks/ses/${team.id}`,
  );
});

it("refuses a second connect over a live one", async () => {
  const { connectWithKeys } = await import("@/services/aws-connect");
  const res = await connectWithKeys(team.id, "acme-corp", {
    accessKeyId: "AKIAEXAMPLE00001",
    secretAccessKey: "s".repeat(20),
    region: "us-east-1",
  });
  expect(res).toMatchObject({ ok: false, code: "ALREADY_CONNECTED" });
});

it("leaves another team unconnected", async () => {
  const other = (await seedTeamWithKey()).team.id;
  const { getTeamAws } = await import("@/services/team-aws");
  expect(await getTeamAws(other)).toBeNull();
});

it("gives two orgs on one AWS account distinct resources", async () => {
  const other = await seedTeamWithKey();
  const { connectWithKeys } = await import("@/services/aws-connect");
  // Same credentials, same AWS account, different org.
  const res = await connectWithKeys(other.team.id, "beta-co", {
    accessKeyId: "AKIAEXAMPLE00000",
    secretAccessKey: "s".repeat(20),
    region: "us-east-1",
  });
  expect(res.ok).toBe(true);
  const { getTeamAws } = await import("@/services/team-aws");
  const a = await getTeamAws(team.id);
  const b = await getTeamAws(other.team.id);
  expect(b?.configSet).toBe("sendsprite-beta-co");
  expect(b?.configSet).not.toBe(a?.configSet);
  expect(b?.snsTopicArn).not.toBe(a?.snsTopicArn);
  // The second connect must not have repointed the first team's
  // destination: each CreateConfigurationSetEventDestination call names its
  // own configuration set.
  const dests = sesMock
    .commandCalls(CreateConfigurationSetEventDestinationCommand)
    .map((c) => c.args[0].input.ConfigurationSetName);
  expect(new Set(dests).size).toBe(dests.length);
});

it("keeps the stored names when the slug changes", async () => {
  const { organization } = await import("@/db/schema");
  const { getTeamAws } = await import("@/services/team-aws");
  const before = await getTeamAws(team.id);
  await pg.db
    .update(organization)
    .set({ slug: "renamed-co" })
    .where(eq(organization.id, team.id));
  const after = await getTeamAws(team.id);
  expect(after?.configSet).toBe(before?.configSet);
  expect(after?.snsTopicArn).toBe(before?.snsTopicArn);
});
```

`getTeamAws` is wrapped in `React.cache`; if the two reads in the rename test
return the same memoised object, read through `pg.db` directly instead.

`APP_URL` must be https for `subscribeEndpoint` to subscribe at all; set
`process.env.APP_URL = "https://test.example.com"` in this file's `beforeAll`
if it is not already.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && bun run test:integration -- aws-connect
```

Expected: FAIL — `connectWithKeys` takes the wrong number of arguments.

- [ ] **Step 3: Thread the team and slug through**

In `apps/web/src/services/aws-connect.ts`:

Delete the `CONFIG_SET` and `TOPIC_NAME` constants and import the derivations:

```ts
import { configSetName, topicName } from "@/lib/aws/naming";
```

`EVENT_DESTINATION` stays a constant — it is scoped inside a configuration
set that is now unique.

Give `ensureSesInfrastructure` the names:

```ts
async function ensureSesInfrastructure(
  ctx: AwsContext,
  configSet: string,
  topic: string,
): Promise<{ topicArn: string }> {
```

replacing every `CONFIG_SET` with `configSet` and the `CreateTopicCommand`
`Name: TOPIC_NAME` with `Name: topic`.

Make `subscribeEndpoint` team-scoped:

```ts
export async function subscribeEndpoint(
  ctx: AwsContext,
  topicArn: string,
  teamId: string,
): Promise<string | null> {
  const endpoint = `${loadEnv().APP_URL}/api/webhooks/ses/${teamId}`;
```

leaving the rest of that function unchanged.

Rewrite `finishConnect` to write `team_aws`:

```ts
async function finishConnect(
  teamId: string,
  slug: string,
  ctx: AwsContext,
  keys: { accessKeyId: string; secretAccessKey: string },
  actor: Actor,
): Promise<Result<Connected>> {
  const { accountId, account } = await verifyIdentity(ctx);
  const configSet = configSetName(slug);
  const { topicArn } = await ensureSesInfrastructure(
    ctx,
    configSet,
    topicName(slug),
  );
  const now = new Date();
  await updateTeamAws(
    teamId,
    {
      region: ctx.region,
      accountId,
      connectedAt: now,
      accessKey: keys.accessKeyId,
      secret: keys.secretAccessKey,
      configSet,
      snsTopicArn: topicArn,
      snsSubscriptionArn: null,
      ...accountPatch(account),
      sesLastCheckedAt: now,
    },
    actor,
    { action: "aws.connect" },
  );
  // Past this point the connection is persisted and consistent. A subscribe
  // failure is a warning, not an error, so the CloudFormation callback never
  // rolls back a working connection.
  let warning: string | undefined;
  try {
    const snsSubscriptionArn = await subscribeEndpoint(ctx, topicArn, teamId);
    await updateTeamAws(teamId, { snsSubscriptionArn }, undefined, {
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
```

Update the three public entry points to take `(teamId, slug, …)`:
`connectWithKeys`, `refreshSesAccount`, `requestProductionAccess`, and
`disconnectAws`. Replace each `(await getInstanceSettings()).awsMode !== "none"`
guard with `(await getTeamAws(teamId)) !== null`, and each
`updateInstanceSettings` call with the matching `updateTeamAws(teamId, …)`.
`disconnectAws` delegates to `disconnectTeamAws(teamId, actor)` after its
existing best-effort SNS unsubscribe.

Delete `detectInstanceRole` entirely along with its `instance_role` branch —
the mode no longer exists.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && bun run test:integration -- aws-connect
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd D:/Documents/Work/Mail
git add apps/web/src/services/aws-connect.ts apps/web/tests/integration/aws-connect.test.ts
git commit -m "feat(aws): connect, refresh and disconnect per team with slug-named resources"
```

---

## Task 6: Team-scoped Cloudflare

**Files:**

- Modify: `apps/web/src/services/cloudflare-connect.ts`
- Modify: `apps/web/src/app/api/setup/cloudflare/start/route.ts`
- Modify: `apps/web/src/app/api/setup/cloudflare/callback/route.ts`
- Test: `apps/web/tests/integration/cloudflare-connect.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/web/tests/integration/cloudflare-connect.test.ts`, change the
existing fixture helper at the top of the file to seed a team and write to
`team_cloudflare`, then add:

```ts
it("keeps one team's grant invisible to another", async () => {
  const other = (await seedTeamWithKey()).team.id;
  const { getTeamCloudflare } = await import("@/services/cloudflare-connect");
  expect(await getTeamCloudflare(other)).toBeNull();
});

it("disconnect deletes only the calling team's row", async () => {
  const { disconnectCloudflare, getTeamCloudflare } =
    await import("@/services/cloudflare-connect");
  await disconnectCloudflare(teamId, { userId: "u_a" });
  expect(await getTeamCloudflare(teamId)).toBeNull();
  expect(await getTeamCloudflare(otherTeamId)).not.toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && bun run test:integration -- cloudflare-connect
```

Expected: FAIL — `getTeamCloudflare` is not exported.

- [ ] **Step 3: Move the token storage onto the team**

In `apps/web/src/services/cloudflare-connect.ts`, add the reader and the
writer, replacing the existing `persist` helper:

```ts
/** Null means this team has not authorised Cloudflare. */
export const getTeamCloudflare = cache(
  async (teamId: string): Promise<TeamCloudflare | null> => {
    const [row] = await db()
      .select()
      .from(teamCloudflare)
      .where(eq(teamCloudflare.teamId, teamId))
      .limit(1);
    return row ?? null;
  },
);

/**
 * Store a token set for one team. A refresh sends `refreshToken: undefined`
 * when Cloudflare did not rotate it, which must leave the stored one alone —
 * hence the conditional spread rather than a blanket write.
 */
async function persistTeam(
  teamId: string,
  t: TokenSet,
  extra: Record<string, unknown> = {},
) {
  const c = getCipher();
  const set = {
    accessTokenEnc: c.encrypt(t.accessToken),
    ...(t.refreshToken !== undefined && {
      refreshTokenEnc: t.refreshToken ? c.encrypt(t.refreshToken) : null,
    }),
    tokenExpiresAt: t.expiresAt ?? null,
    ...extra,
    updatedAt: new Date(),
  };
  const [row] = await db()
    .insert(teamCloudflare)
    .values({ teamId, connectedAt: new Date(), ...set })
    .onConflictDoUpdate({ target: teamCloudflare.teamId, set })
    .returning();
  if (!row) throw new Error("team_cloudflare upsert returned no row");
  return row;
}
```

Then:

- `completeOauth(teamId, …)`, `disconnectCloudflare(teamId, actor)`,
  `accessToken(teamId, fetch)`, `cloudflareClient(teamId, …)` and
  `listZones(teamId, …)` all take the team.
- `beginOauth` gains `teamId` and puts it in the state cookie payload
  alongside the PKCE verifier, so the callback knows which team authorised
  without trusting a query parameter.
- `disconnectCloudflare` deletes the row rather than nulling columns, and
  keeps its best-effort token revoke.
- The self-disconnect on a rejected refresh becomes a delete of that team's
  row only.

`oauthClient()` and `oauthAvailable()` stay instance-level: the OAuth client
is registered per deployment, and only the _grant_ is per team.

- [ ] **Step 4: Update the routes**

`start/route.ts` resolves the active team via `requireTeamAdmin()` and passes
its id to `beginOauth`. `callback/route.ts` reads the team out of the state
cookie and passes it to `completeOauth`.

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/web && bun run test:integration -- cloudflare-connect
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd D:/Documents/Work/Mail
git add apps/web/src/services/cloudflare-connect.ts apps/web/src/app/api/setup/cloudflare apps/web/tests/integration/cloudflare-connect.test.ts
git commit -m "feat(cloudflare): store the OAuth grant per team"
```

---

## Task 7: Team-scoped SNS ingress and ingest

**Files:**

- Move: `apps/web/src/app/api/webhooks/ses/route.ts` → `apps/web/src/app/api/webhooks/ses/[teamId]/route.ts`
- Modify: `apps/web/src/services/ingest.ts:49-62`
- Test: `apps/web/tests/integration/ses-webhook.test.ts`
- Test: `apps/web/tests/integration/ses-ingest.test.ts`

This is the security-critical task. Do not skip step 1.

- [ ] **Step 1: Write the failing cross-tenant test**

Append to `apps/web/tests/integration/ses-ingest.test.ts`:

```ts
it("refuses an event naming another team's email", async () => {
  const a = await seedTeamWithKey();
  const b = await seedTeamWithKey();
  // An email that belongs to team B.
  const { emails } = await import("@/db/schema");
  await pg.db.insert(emails).values({
    id: "em_victim",
    teamId: b.team.id,
    from: "b@x.com",
    to: ["c@x.com"],
    cc: [],
    bcc: [],
    subject: "s",
    headers: {},
    attachmentsMeta: [],
    status: "sent",
  });
  const { ingestSesEvent } = await import("@/services/ingest");
  // Team A posts an event tagged with B's email id.
  const res = await ingestSesEvent(
    a.team.id,
    {
      eventType: "Bounce",
      mail: {
        messageId: "ses-1",
        tags: { ss_email: ["em_victim"] },
        timestamp: new Date().toISOString(),
      },
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "c@x.com" }],
        timestamp: new Date().toISOString(),
      },
    },
    "sns-msg-1",
    { enqueue: async () => undefined },
  );
  expect(res).toMatchObject({ ok: false, reason: "unknown_email" });
  const { emailEvents } = await import("@/db/schema");
  expect(await pg.db.select().from(emailEvents)).toHaveLength(0);
});
```

Match the event payload shape that `lib/ses-events.ts` actually parses —
copy it from an existing passing test in this file rather than trusting the
sketch above.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && bun run test:integration -- ses-ingest
```

Expected: FAIL — the event is ingested against team B's email, so the result
is `{ ok: true }` and one `email_events` row exists. **That failure is the
vulnerability**; confirm you see it before fixing.

- [ ] **Step 3: Add the team predicate**

In `apps/web/src/services/ingest.ts`, change the signature and both lookups:

```ts
export async function ingestSesEvent(
  teamId: string,
  raw: unknown,
  snsMessageId: string,
  deps: { enqueue: Enqueue },
): Promise<IngestResult> {
```

```ts
const [e] = ev.emailId
  ? await db()
      .select()
      .from(emails)
      .where(and(eq(emails.teamId, teamId), eq(emails.id, ev.emailId)))
  : await db()
      .select()
      .from(emails)
      .where(
        and(
          eq(emails.teamId, teamId),
          eq(emails.sesMessageId, ev.sesMessageId),
        ),
      );
```

Add `and` to the `drizzle-orm` import, and extend the doc comment:

```ts
 * Attribution is by the `ss_email` tag, then by `ses_message_id`, **always
 * within the posting team**. Every tenant runs its own AWS account and posts
 * to its own webhook path, so without the team predicate one tenant could
 * name another tenant's email id and write events, status changes and
 * suppressions into their timeline.
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && bun run test:integration -- ses-ingest
```

Expected: PASS.

- [ ] **Step 5: Move the route**

```bash
cd D:/Documents/Work/Mail
mkdir -p "apps/web/src/app/api/webhooks/ses/[teamId]"
git mv apps/web/src/app/api/webhooks/ses/route.ts "apps/web/src/app/api/webhooks/ses/[teamId]/route.ts"
```

- [ ] **Step 6: Authorise by path and topic**

In the moved route, take the param and replace the settings lookup:

```ts
export async function POST(
  req: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await params;
```

```ts
// Two independent checks. The path alone is guessable; the topic ARN alone
// is the old instance-wide check and says nothing about which tenant the
// message is for. Both must hold.
const aws = await getTeamAws(teamId);
if (!aws?.snsTopicArn || msg.TopicArn !== aws.snsTopicArn)
  return NextResponse.json({ error: "unknown_topic" }, { status: 403 });
```

Replace both `updateInstanceSettings({ snsSubscriptionArn … })` calls with
`updateTeamAws(teamId, { snsSubscriptionArn … }, undefined, { audit: false })`,
pass `teamId` to `confirmSubscription` so it calls
`resolveAwsContext(teamId)`, and pass `teamId` as the first argument to
`ingestSesEvent`.

- [ ] **Step 7: Update the webhook route tests**

In `apps/web/tests/integration/ses-webhook.test.ts`, point every request at
`/api/webhooks/ses/<teamId>` and pass the param through to the handler, then
add:

```ts
it("rejects a topic that belongs to another team", async () => {
  const res = await POST(request(bodyForTopic(OTHER_TOPIC)), {
    params: Promise.resolve({ teamId }),
  });
  expect(res.status).toBe(403);
});

it("rejects a team with no connection", async () => {
  const res = await POST(request(bodyForTopic(TOPIC)), {
    params: Promise.resolve({ teamId: "org_nope" }),
  });
  expect(res.status).toBe(403);
});
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd apps/web && bun run test:integration -- ses-webhook ses-ingest
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd D:/Documents/Work/Mail
git add -A apps/web/src/app/api/webhooks apps/web/src/services/ingest.ts apps/web/tests/integration
git commit -m "feat(ses): scope the SNS webhook and event ingest to a team

Ingest resolved an email by ss_email tag with no team predicate, so with one
AWS account per tenant, tenant A could name tenant B's email id and write
events, status changes and suppressions into B's timeline."
```

---

## Task 8: Per-team send limits

**Files:**

- Modify: `apps/web/src/services/send-limits.ts:27-55,240-298`
- Modify: `apps/web/src/services/emails.ts:272`
- Modify: `apps/web/src/services/campaigns/fanout.ts:862`
- Modify: `apps/web/src/lib/api-response.ts:118-143`
- Modify: `apps/web/src/app/app/campaigns/send.ts:148-244`
- Test: `apps/web/tests/integration/send-limits.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/tests/integration/send-limits.test.ts`:

```ts
it("gives each team its own bucket", async () => {
  const a = await seedTeamWithKey();
  const b = await seedTeamWithKey();
  const { connectTeamAws } = await import("./helpers");
  await connectTeamAws(a.team.id, { sesMaxSendRate: 1 });
  await connectTeamAws(b.team.id, { sesMaxSendRate: 1 });

  const { takeSesToken, resetRateForTests } =
    await import("@/services/send-limits");
  const now = new Date("2026-08-26T00:00:00Z");
  await resetRateForTests(a.team.id, now);
  await resetRateForTests(b.team.id, now);

  // Drain A.
  expect(await takeSesToken(a.team.id, now)).toMatchObject({ ok: true });
  expect(await takeSesToken(a.team.id, now)).toMatchObject({ ok: false });
  // B is untouched.
  expect(await takeSesToken(b.team.id, now)).toMatchObject({ ok: true });
});

it("counts only the calling team against the account quota", async () => {
  const a = await seedTeamWithKey();
  const b = await seedTeamWithKey();
  const { connectTeamAws } = await import("./helpers");
  await connectTeamAws(a.team.id, { sesDailyQuota: 1 });
  await connectTeamAws(b.team.id, { sesDailyQuota: 1 });
  // Seed one sent email for team B only.
  await seedSentEmail(b.team.id);

  const { checkAccountQuota } = await import("@/services/send-limits");
  expect(await checkAccountQuota(a.team.id, 1)).toMatchObject({ ok: true });
  expect(await checkAccountQuota(b.team.id, 1)).toMatchObject({
    ok: false,
    code: "daily_quota_exceeded",
  });
});
```

Reuse the file's existing helper for inserting a sent email in place of
`seedSentEmail` if one is already defined there.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/web && bun run test:integration -- send-limits
```

Expected: FAIL — `takeSesToken` takes one argument, `checkAccountQuota` does
not exist.

- [ ] **Step 3: Make the bucket per team**

In `apps/web/src/services/send-limits.ts`:

```ts
export async function takeSesToken(
  teamId: string,
  now = new Date(),
): Promise<TokenResult> {
  const aws = await getTeamAws(teamId);
  const rate = Math.max(1, aws?.sesMaxSendRate ?? 1);
  return db().transaction(async (tx) => {
    await tx
      .insert(teamSendRate)
      .values({ teamId, tokens: rate, refilledAt: now })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(teamSendRate)
      .where(eq(teamSendRate.teamId, teamId))
      .for("update");
    if (!row) throw new Error("team_send_rate row missing");
```

keeping the clock, refill and return logic exactly as it is, and updating the
final `tx.update(...)` to `where(eq(teamSendRate.teamId, teamId))`.

Update the doc comment: the `for update` lock now serialises workers **per
team** rather than instance-wide, which is both the correct semantics and
strictly less contention.

`resetRateForTests(teamId, now)` takes the team the same way.

- [ ] **Step 4: Make the quota per team**

Rename `checkInstanceQuota` to `checkAccountQuota` and scope both the settings
read and the count:

```ts
/**
 * SES `Max24HourSend` is account-wide, and every team now has its own AWS
 * account — so "account-wide" means that team's sends in the trailing 24 h.
 * In-flight `sending` rows have no `sent_at` yet and are not counted, so this
 * is a soft cap; SES itself is the hard one.
 */
export async function checkAccountQuota(
  teamId: string,
  adding: number,
  now = new Date(),
): Promise<CapResult> {
  const aws = await getTeamAws(teamId);
  if (!aws?.sesDailyQuota) return { ok: true };
  return (await countSentLast24h(teamId, now)) + adding > aws.sesDailyQuota
    ? {
        ok: false,
        code: "daily_quota_exceeded",
        message: `SES 24-hour quota of ${aws.sesDailyQuota} reached.`,
      }
    : { ok: true };
}
```

and give `countSentLast24h(teamId, now)` an `eq(emails.teamId, teamId)`
predicate.

- [ ] **Step 5: Simplify `usageSnapshot`**

Rename the two fields and drop the `capped` shortcut:

```ts
/** The team's SES Max24HourSend, null when AWS is not connected. */
accountQuota: number | null;
/** That team's sends in the trailing 24 h. */
accountUsed: number;
```

```ts
export async function usageSnapshot(
  teamId: string,
  now = new Date(),
): Promise<UsageSnapshot> {
  const caps = await resolveTeamCaps(teamId, now);
  const aws = await getTeamAws(teamId);
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
    accountQuota: aws?.sesDailyQuota ?? null,
    accountUsed: await countSentLast24h(teamId, now),
  };
}
```

The old comment on `usageSnapshot` about skipping the instance-wide scan goes
with it — team-scoped, the count is an indexed query on `(team_id, sent_at)`.

- [ ] **Step 6: Update the callers**

- `services/emails.ts:272` → `checkAccountQuota(actor.teamId, 1, now)`
- `services/campaigns/fanout.ts:862` → `checkAccountQuota(teamId, adding, now)`
  and fix the surrounding comment that names `checkInstanceQuota`
- `services/ses-send.ts:146` → `takeSesToken(e.teamId, now)`
- `lib/api-response.ts:139-143` → `u.accountQuota` / `u.accountUsed`
  (**the `x-ratelimit-*` header names do not change**)
- `app/app/campaigns/send.ts:148-149,243-244` → rename the two fields and
  **delete** the comment block at 186 warning that `instanceUsed: 0` cannot be
  believed; it described the shortcut that no longer exists

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd apps/web && bun run test:integration -- send-limits email-send campaign-fanout
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd D:/Documents/Work/Mail
git add apps/web/src apps/web/tests
git commit -m "feat(limits): per-team rate bucket and account quota"
```

---

## Task 9: Sending, domains and jobs

**Files:**

- Modify: `apps/web/src/services/ses-send.ts:176-180`
- Modify: `apps/web/src/services/domains.ts:153,285,622`
- Modify: `apps/web/src/jobs/handlers/ses-refresh-account.ts`

- [ ] **Step 1: Thread the team through sending**

In `apps/web/src/services/ses-send.ts`, replace:

```ts
const ctx = await resolveAwsContext();
const settings = await getInstanceSettings();
```

with:

```ts
const ctx = await resolveAwsContext(e.teamId);
const aws = await getTeamAws(e.teamId);
```

and every later `settings.sesConfigSet` with `aws?.configSet`. Update the
`## Cost` doc block that names `getInstanceSettings` to name `getTeamAws`,
and its claim that the rate lock "serialises every worker in the instance" —
it now serialises every worker **for that team**.

- [ ] **Step 2: Thread the team through domains**

In `apps/web/src/services/domains.ts`:

```ts
const aws = await getTeamAws(actor.teamId);
if (!aws)
  return {
    ok: false,
    code: "not_configured",
    error: "Connect AWS first (Settings → Sending).",
  };
```

replacing the `awsMode === "none" || !settings.awsRegion` check at line 153.
At line 285 use `resolveAwsContext(d.teamId)` and `aws.configSet`; at line 622
replace the `awsMode !== "none"` check with `(await getTeamAws(d.teamId)) !== null`
and pass `d.teamId` to `resolveAwsContext`.

- [ ] **Step 3: Iterate teams in the refresh job**

Replace `apps/web/src/jobs/handlers/ses-refresh-account.ts` with:

```ts
import { registerQueue } from "../boss";
import { Q } from "../queues";
import { db } from "@/db";
import { teamAws } from "@/db/schema";
import { refreshSesAccount } from "@/services/aws-connect";

/**
 * Hourly SES account refresh, once per connected team. Each team is isolated:
 * one tenant's expired keys or revoked policy must not cost every other
 * tenant their refresh.
 */
registerQueue(
  Q.sesRefreshAccount,
  async () => {
    const rows = await db().select({ teamId: teamAws.teamId }).from(teamAws);
    for (const { teamId } of rows) {
      try {
        const r = await refreshSesAccount(teamId);
        if (!r.ok) console.warn(`[ses] refresh failed for ${teamId}:`, r.error);
      } catch (e) {
        console.warn(
          `[ses] refresh threw for ${teamId}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  },
  // retryLimit 0: a failed check is simply retried by the next tick.
  // :17 keeps the GetAccount calls off the top-of-the-hour crowd.
  { cron: "17 * * * *", queue: { retryLimit: 0 } },
);
```

- [ ] **Step 4: Run the affected tests**

```bash
cd apps/web && bun run test:integration -- domains domain-loop email-send
```

Expected: these still fail on fixtures until task 13 rewrites them. Confirm
the failures are `updateInstanceSettings` fixture errors and **not** logic
errors in the code you just wrote.

- [ ] **Step 5: Commit**

```bash
cd D:/Documents/Work/Mail
git add apps/web/src
git commit -m "refactor(aws): resolve the team in sending, domains and the refresh job"
```

---

## Task 10: Setup tokens, quick-create and callbacks

**Files:**

- Modify: `apps/web/src/services/setup-tokens.ts`
- Modify: `apps/web/src/app/setup/actions.ts`
- Modify: `apps/web/src/app/api/setup/aws/callback/route.ts`
- Modify: `apps/web/src/app/api/setup/aws/status/route.ts`
- Test: `apps/web/tests/integration/setup-callback.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/tests/integration/setup-callback.test.ts`:

```ts
it("connects the team named on the token", async () => {
  const { issueSetupToken } = await import("@/services/setup-tokens");
  const { token } = await issueSetupToken({
    purpose: "aws_callback",
    issuedBy: actor.userId,
    teamId: team.id,
    region: "us-east-1",
    ttlMs: 60_000,
  });
  const res = await POST(
    request({
      token,
      accessKeyId: "AKIAEXAMPLE00000",
      secretAccessKey: "s".repeat(20),
      region: "us-east-1",
    }),
  );
  expect(res.status).toBe(200);
  const { getTeamAws } = await import("@/services/team-aws");
  expect(await getTeamAws(team.id)).not.toBeNull();
  expect(await getTeamAws(otherTeam.id)).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && bun run test:integration -- setup-callback
```

Expected: FAIL — `issueSetupToken` rejects the unknown `teamId` property, or
the row violates the new `not null` column.

- [ ] **Step 3: Carry the team on the token**

In `apps/web/src/services/setup-tokens.ts` add `teamId: string` to the
`issueSetupToken` input and persist it; return it from `consumeSetupToken`.
Scope `revokePendingSetupTokens(purpose, issuedBy)` to the team as well so one
owner's retry in team A cannot revoke their pending token in team B.

- [ ] **Step 4: Name the stack after the org**

In `apps/web/src/app/setup/actions.ts`, `startQuickCreate` resolves the team,
stamps the token and names the stack:

```ts
  const a = await actor();
  …
  await revokePendingSetupTokens("aws_callback", a.userId, a.teamId);
  const { token } = await issueSetupToken({
    purpose: "aws_callback",
    issuedBy: a.userId,
    teamId: a.teamId,
    region: r,
    ttlMs: 60 * 60_000,
  });
  return {
    ok: true,
    data: {
      url: buildQuickCreateUrl({
        region: r,
        templateUrl: env.CFN_TEMPLATE_URL,
        callbackUrl: `${env.APP_URL}/api/setup/aws/callback`,
        callbackToken: token,
        stackName: stackName(a.teamSlug),
      }),
    },
  };
```

with `import { stackName } from "@/lib/aws/naming";`. Change the local
`actor()` helper to use `requireTeamAdmin()` and to return `teamId`,
`teamSlug` and `userId`. Delete the `detectRole` action along with the
`detectInstanceRole` service it called.

- [ ] **Step 5: Pass the team into the callback**

In `apps/web/src/app/api/setup/aws/callback/route.ts`, call
`connectWithKeys(tok.teamId, tok.teamSlug, {…}, { userId: tok.issuedBy })`.
Resolve the slug by joining `organization` in `consumeSetupToken` so the route
needs no extra query.

In `apps/web/src/app/api/setup/aws/status/route.ts`, replace
`getInstanceSettings()` with `getTeamAws(teamId)` for the caller's active team.

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd apps/web && bun run test:integration -- setup-callback setup-tokens
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd D:/Documents/Work/Mail
git add apps/web/src apps/web/tests
git commit -m "feat(setup): bind the CloudFormation callback to a team and name the stack after the org"
```

---

## Task 11: Slim `instance-settings.ts`

**Files:**

- Modify: `apps/web/src/services/instance-settings.ts`
- Modify: `apps/web/src/db/schema/instance.ts`
- Modify: `apps/web/tests/integration/instance-settings.test.ts`

- [ ] **Step 1: Drop the cloud columns from the table**

In `apps/web/src/db/schema/instance.ts` remove every `aws*`, `ses*`, `sns*`
and `cloudflare*` column and `setupCompleted`, leaving `id`, `signupMode`,
`landingEnabled`, `retentionDays`, `createdAt`, `updatedAt` and the singleton
check. Update the leading comment to say what the row is now for.

- [ ] **Step 2: Slim the service**

In `apps/web/src/services/instance-settings.ts` delete `getDecryptedSecrets`,
the `Secrets` type and the whole encryption block; `Plain` becomes
`Partial<Omit<InstanceSettings, "id" | "createdAt" | "updatedAt">>`. Keep the
lazy singleton creation, the audit diff and the `opts.action` behaviour.

- [ ] **Step 3: Rewrite the test file**

In `apps/web/tests/integration/instance-settings.test.ts` delete every test
that exercises AWS or Cloudflare columns or secrets — those behaviours now
live in `team-aws.test.ts` and `cloudflare-connect.test.ts` — and keep the
singleton-creation, plain-patch and audit-row tests, retargeted at
`signupMode`, `landingEnabled` and `retentionDays`.

- [ ] **Step 4: Run the test**

```bash
cd apps/web && bun run test:integration -- instance-settings
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd D:/Documents/Work/Mail
git add apps/web/src apps/web/tests
git commit -m "refactor(instance): keep only operator settings on the singleton"
```

---

## Task 12: Pages

**Files:**

- Modify: `apps/web/src/app/setup/page.tsx`, `types.ts`, `steps/AwsStep.tsx`, `steps/CloudflareStep.tsx`
- Move: `apps/web/src/app/app/settings/instance/` → `apps/web/src/app/app/settings/sending/`
- Create: `apps/web/src/app/app/settings/instance/page.tsx` (redirect)
- Modify: `apps/web/src/app/app/layout.tsx`, `app/(onboarding)/waiting/page.tsx`, `src/lib/team.ts`
- Modify: `apps/web/src/app/app/page.tsx`, `app/app/domains/page.tsx`, `app/app/domains/new/page.tsx`, `components/app/AppShell.tsx`

- [ ] **Step 1: Move the settings page**

```bash
cd D:/Documents/Work/Mail
git mv apps/web/src/app/app/settings/instance apps/web/src/app/app/settings/sending
mkdir -p apps/web/src/app/app/settings/instance
```

Create `apps/web/src/app/app/settings/instance/page.tsx`:

```tsx
import { redirect } from "next/navigation";

/** Renamed in phase 9: the page is a team's own AWS/Cloudflare connection. */
export default function InstanceSettingsRedirect() {
  redirect("/app/settings/sending");
}
```

- [ ] **Step 2: Retarget the wizard types**

In `apps/web/src/app/setup/types.ts` replace `WizardSettings` with the
team-shaped view:

```ts
/** The non-secret slice of a team's connection the wizard renders. */
export interface WizardSettings {
  awsConnected: boolean;
  awsRegion: string | null;
  awsAccountId: string | null;
  sesAccountStatus: "sandbox" | "requested" | "production" | null;
  sesReviewStatus: "PENDING" | "GRANTED" | "DENIED" | "FAILED" | null;
  sesDailyQuota: number | null;
  sesMaxSendRate: number | null;
  /** Topic exists but no confirmed subscription: events are not arriving. */
  snsSubscriptionMissing: boolean;
  cloudflareConnectedAt: string | null;
  cloudflareAccountName: string | null;
  setupCompleted: boolean;
}
```

- [ ] **Step 3: Update both pages that build it**

`apps/web/src/app/setup/page.tsx` and
`apps/web/src/app/app/settings/sending/page.tsx` both switch to
`requireTeamAdmin()`, read `getTeamAws(ctx.team.id)` and
`getTeamCloudflare(ctx.team.id)`, and build:

```tsx
const settings: WizardSettings = {
  awsConnected: aws !== null,
  awsRegion: aws?.region ?? null,
  awsAccountId: aws?.accountId ?? null,
  sesAccountStatus: aws?.sesAccountStatus ?? null,
  sesReviewStatus: aws?.sesReviewStatus ?? null,
  sesDailyQuota: aws?.sesDailyQuota ?? null,
  sesMaxSendRate: aws?.sesMaxSendRate ?? null,
  snsSubscriptionMissing: Boolean(aws?.snsTopicArn && !aws.snsSubscriptionArn),
  cloudflareConnectedAt: cf?.connectedAt?.toISOString() ?? null,
  cloudflareAccountName: cf?.accountName ?? null,
  setupCompleted: teamSettings?.setupCompleted ?? false,
};
```

The step resolution in `setup/page.tsx` changes its first branch from
`s.awsMode === "none"` to `!settings.awsConnected`.

- [ ] **Step 4: Update the steps**

In `AwsStep.tsx` remove the "use the instance role" option and its
`detectRole` call entirely, and drive the connected/disconnected view from
`awsConnected`. Add the reconnect banner:

```tsx
{
  settings.snsSubscriptionMissing && (
    <Notice>
      SES events are not being delivered: this connection has a topic but no
      confirmed subscription. Reconnect to resume event delivery.
    </Notice>
  );
}
```

`CloudflareStep.tsx` needs no structural change — its three states already
key off `cloudflareConnectedAt`.

- [ ] **Step 5: Gate the app on the team's own setup**

`apps/web/src/app/app/layout.tsx`:

```tsx
const ctx = await requireTeam();
const ts = await getTeamSettings(ctx.team.id);
// Until an owner or admin connects this team's AWS account the dashboard is
// closed: they go set it up, everyone else waits (both routes live outside
// this layout).
if (!ts?.setupCompleted)
  redirect(
    ctx.role === "owner" || ctx.role === "admin" ? "/setup" : "/waiting",
  );
```

and `sesStatus` comes from `getTeamAws(ctx.team.id)`.

`app/(onboarding)/waiting/page.tsx` reads the same flag, redirects owner and
admin to `/setup`, and lists contacts with
`listTeamAdminEmails(ctx.team.id)` in place of `listOwnerEmails(ctx.userId)`.
Update its copy from "An owner is finishing setup" to "An admin is connecting
this team's AWS account".

In `src/lib/team.ts`, narrow `listOwnerEmails` to one team:

```ts
/**
 * Owner and admin emails to show a member waiting on setup — for **their own
 * team only**. The instance-wide fallback is gone: with AWS on the team, an
 * owner of an unrelated team cannot finish your setup, so listing them just
 * sends the member to the wrong person.
 */
export async function listTeamAdminEmails(teamId: string): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ email: user.email })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(
      and(
        eq(member.organizationId, teamId),
        inArray(member.role, ["owner", "admin"]),
      ),
    )
    .orderBy(user.email);
  return rows.map((r) => r.email);
}
```

- [ ] **Step 6: Fix the remaining readers**

`app/app/page.tsx`, `app/app/domains/page.tsx` and
`app/app/domains/new/page.tsx` swap `getInstanceSettings()` for
`getTeamAws(ctx.team.id)` and their `awsMode === "none"` checks for a null
check. `components/app/AppShell.tsx` takes `sesStatus` unchanged but drops its
`InstanceSettings` type import in favour of `TeamAws`.

- [ ] **Step 7: Typecheck — this is the green gate**

```bash
cd D:/Documents/Work/Mail && bun run typecheck
```

Expected: **clean**. This is the first clean typecheck since task 2. If
anything still refers to `awsMode`, `getDecryptedSecrets` or
`checkInstanceQuota`, fix it now.

- [ ] **Step 8: Commit**

```bash
cd D:/Documents/Work/Mail
git add -A apps/web/src
git commit -m "feat(ui): team-scoped setup wizard and sending settings page"
```

---

## Task 13: Test fixtures

**Files:**

- Modify: `apps/web/tests/integration/helpers.ts`
- Modify: every integration test that calls `updateInstanceSettings`

- [ ] **Step 1: Add the fixture**

Append to `apps/web/tests/integration/helpers.ts`:

```ts
/**
 * Give a team a connected AWS account. Tests used to reach for
 * `updateInstanceSettings` directly; a helper keeps the intent readable and
 * means the next signature change touches one file instead of fourteen.
 */
export async function connectTeamAws(
  teamId: string,
  patch: Partial<{
    region: string;
    accountId: string;
    configSet: string;
    snsTopicArn: string;
    snsSubscriptionArn: string;
    sesAccountStatus: "sandbox" | "requested" | "production";
    sesDailyQuota: number;
    sesMaxSendRate: number;
  }> = {},
) {
  process.env.APP_SECRET ??= "x".repeat(40);
  const { updateTeamAws } = await import("@/services/team-aws");
  return updateTeamAws(
    teamId,
    {
      region: "us-east-1",
      accessKey: "AKIAEXAMPLE00000",
      secret: "s".repeat(20),
      configSet: "sendsprite-test",
      connectedAt: new Date(),
      sesAccountStatus: "production",
      ...patch,
    },
    undefined,
    { audit: false },
  );
}
```

- [ ] **Step 2: Find every caller**

```bash
cd apps/web && grep -rln "updateInstanceSettings" tests/
```

- [ ] **Step 3: Replace them**

For each file, replace the `updateInstanceSettings({ awsMode: "keys", … })`
fixture with `connectTeamAws(teamId, { … })`, and each
`updateInstanceSettings({ awsMode: "none" })` (used to test the
not-configured path) with a team that simply has no `team_aws` row — seed a
fresh team instead of clearing a shared one.

`tests/integration/ses-ingest.test.ts` mocks
`getInstanceSettings: async () => ({ snsTopicArn: TOPIC })`; change that mock
to `@/services/team-aws`'s `getTeamAws`.

Keep genuine instance-settings fixtures (`retentionDays`, `signupMode`) as
they are.

- [ ] **Step 4: Run the whole suite**

```bash
cd D:/Documents/Work/Mail
bun run test
bun run test:integration
```

Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
cd D:/Documents/Work/Mail
git add apps/web/tests
git commit -m "test: connect AWS per team through a fixture helper"
```

---

## Task 14: Migrations 0022 and 0023

**Files:**

- Create: `apps/web/drizzle/0022_move_instance_connection.sql`
- Create: `apps/web/drizzle/0023_drop_instance_cloud_columns.sql`
- Create: `apps/web/tests/integration/migration-0022.test.ts`

- [ ] **Step 1: Write the data-move migration by hand**

Create `apps/web/drizzle/0022_move_instance_connection.sql`:

```sql
--> statement-breakpoint
-- Move the single instance connection onto the oldest organization.
-- Ciphertext is copied verbatim: same APP_SECRET, no re-encryption.
--
-- The legacy resource names ("sendsprite", "sendsprite-events") are copied
-- as-is and MUST NOT be renamed here: those resources already exist in that
-- AWS account under those names, and every read uses the stored value. Only
-- a fresh connect produces slug-scoped names.
--
-- `aws_mode = 'instance_role'` cannot be carried: there are no keys to copy
-- and `team_aws.access_key_enc` is NOT NULL. Such an instance migrates with
-- no row and reconnects through the wizard.
INSERT INTO team_aws (
  team_id, region, access_key_enc, secret_enc, account_id, connected_at,
  config_set, sns_topic_arn, sns_subscription_arn, ses_account_status,
  ses_review_status, ses_daily_quota, ses_max_send_rate, ses_last_checked_at
)
SELECT
  o.id, s.aws_region, s.aws_access_key_enc, s.aws_secret_enc, s.aws_account_id,
  COALESCE(s.aws_connected_at, now()), COALESCE(s.ses_config_set, 'sendsprite'),
  s.sns_topic_arn, s.sns_subscription_arn, s.ses_account_status,
  s.ses_review_status, s.ses_daily_quota, s.ses_max_send_rate,
  s.ses_last_checked_at
FROM instance_settings s
CROSS JOIN LATERAL (
  SELECT id FROM organization ORDER BY created_at, id LIMIT 1
) o
WHERE s.id = 1
  AND s.aws_mode = 'keys'
  AND s.aws_region IS NOT NULL
  AND s.aws_access_key_enc IS NOT NULL
  AND s.aws_secret_enc IS NOT NULL
ON CONFLICT (team_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO team_cloudflare (
  team_id, access_token_enc, refresh_token_enc, token_expires_at,
  account_name, connected_at
)
SELECT
  o.id, s.cloudflare_access_token_enc, s.cloudflare_refresh_token_enc,
  s.cloudflare_token_expires_at, s.cloudflare_account_name,
  s.cloudflare_connected_at
FROM instance_settings s
CROSS JOIN LATERAL (
  SELECT id FROM organization ORDER BY created_at, id LIMIT 1
) o
WHERE s.id = 1
  AND s.cloudflare_connected_at IS NOT NULL
  AND s.cloudflare_access_token_enc IS NOT NULL
ON CONFLICT (team_id) DO NOTHING;
--> statement-breakpoint
-- Carry the instance's "setup finished" flag to that same team.
INSERT INTO team_settings (team_id, setup_completed, updated_at)
SELECT o.id, s.setup_completed, now()
FROM instance_settings s
CROSS JOIN LATERAL (
  SELECT id FROM organization ORDER BY created_at, id LIMIT 1
) o
WHERE s.id = 1
ON CONFLICT (team_id) DO UPDATE SET
  setup_completed = EXCLUDED.setup_completed, updated_at = now();
--> statement-breakpoint
-- Backfill the team on pending setup tokens so the NOT NULL add succeeds.
UPDATE setup_tokens SET team_id = (
  SELECT id FROM organization ORDER BY created_at, id LIMIT 1
) WHERE team_id IS NULL;
```

`CROSS JOIN LATERAL` rather than a scalar subquery so the whole statement is
a no-op when there are no organizations, instead of inserting a NULL team id.

- [ ] **Step 2: Write the destructive migration**

Create `apps/web/drizzle/0023_drop_instance_cloud_columns.sql`:

```sql
--> statement-breakpoint
ALTER TABLE "instance_settings"
  DROP COLUMN "aws_mode",
  DROP COLUMN "aws_region",
  DROP COLUMN "aws_access_key_enc",
  DROP COLUMN "aws_secret_enc",
  DROP COLUMN "aws_account_id",
  DROP COLUMN "aws_connected_at",
  DROP COLUMN "sns_topic_arn",
  DROP COLUMN "sns_subscription_arn",
  DROP COLUMN "ses_config_set",
  DROP COLUMN "ses_account_status",
  DROP COLUMN "ses_review_status",
  DROP COLUMN "ses_max_send_rate",
  DROP COLUMN "ses_daily_quota",
  DROP COLUMN "ses_last_checked_at",
  DROP COLUMN "cloudflare_access_token_enc",
  DROP COLUMN "cloudflare_refresh_token_enc",
  DROP COLUMN "cloudflare_token_expires_at",
  DROP COLUMN "cloudflare_account_name",
  DROP COLUMN "cloudflare_connected_at",
  DROP COLUMN "setup_completed";
--> statement-breakpoint
DROP TABLE "send_rate_state";
```

Then make `setup_tokens.team_id` NOT NULL, which is safe only after 0022's
backfill:

```sql
--> statement-breakpoint
ALTER TABLE "setup_tokens" ALTER COLUMN "team_id" SET NOT NULL;
```

Task 2's generated migration must therefore have added `team_id` as
**nullable**; if it did not, edit 0021 to add it nullable before running this.

- [ ] **Step 3: Verify the journal**

```bash
cd apps/web && cat drizzle/meta/_journal.json | tail -20
```

Hand-written migrations must be listed in `_journal.json` in order, or
`runMigrations` skips them. Add entries matching the surrounding format if
drizzle-kit did not.

- [ ] **Step 4: Write the migration test**

Create `apps/web/tests/integration/migration-0022.test.ts`. It boots a
database migrated only to 0021, seeds an instance row and two organizations,
applies 0022, and asserts the connection landed on the **older** org:

```ts
it("moves the instance connection to the oldest organization", async () => {
  // seed: two orgs, older first; instance_settings with aws_mode='keys'
  // apply 0022
  const rows = await pg.db.select().from(teamAws);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.teamId).toBe(olderOrgId);
  expect(rows[0]?.configSet).toBe("sendsprite");
});

it("is a no-op with no organizations", async () => {
  // seed: instance_settings only
  // apply 0022
  expect(await pg.db.select().from(teamAws)).toHaveLength(0);
});
```

Drive the SQL with `pg.db.execute(sql.raw(readFileSync(...)))`, splitting on
`--> statement-breakpoint`, rather than reaching for drizzle's migrator.

- [ ] **Step 5: Run it**

```bash
cd apps/web && bun run test:integration -- migration-0022
```

Expected: PASS.

- [ ] **Step 6: Full suite and commit**

```bash
cd D:/Documents/Work/Mail
bun run typecheck && bun run test && bun run test:integration
git add apps/web/drizzle apps/web/tests
git commit -m "feat(migrate): move the instance connection onto the oldest org and drop the columns"
```

---

## Task 15: E2E, docs and copy

**Files:**

- Modify: `apps/web/tests/e2e/setup.spec.ts`
- Modify: `apps/web/src/app/docs/domains/page.mdx`
- Modify: `apps/web/src/app/docs/self-hosting/page.mdx`

- [ ] **Step 1: Update the e2e wizard spec**

In `apps/web/tests/e2e/setup.spec.ts` retarget the wizard at a team and add a
second team walking it independently: create team B, assert `/app` redirects
B to `/setup` even though team A finished, and assert B's `/setup` shows no
connection.

- [ ] **Step 2: Update the docs**

In `apps/web/src/app/docs/domains/page.mdx` change every "Settings → Instance"
to "Settings → Sending".

In `apps/web/src/app/docs/self-hosting/page.mdx`:

- State that **each team connects its own AWS account**, and that the
  deployment holds no AWS credentials.
- Remove the instance-role option from the connect instructions.
- Note that the SES webhook endpoint is per team,
  `<APP_URL>/api/webhooks/ses/<team id>`.
- Add the upgrade note: an existing instance's connection moves to the oldest
  team automatically, but its **SNS subscription must be recreated** — open
  Settings → Sending and reconnect. An instance that used the host IAM role
  must reconnect with an IAM user, since that mode is gone.

- [ ] **Step 3: Run e2e**

```bash
cd D:/Documents/Work/Mail && bun run test:e2e
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd D:/Documents/Work/Mail
git add apps/web/tests/e2e apps/web/src/app/docs
git commit -m "docs, test(e2e): per-team AWS connections and the upgrade path"
```

---

## Done when

- Two teams can each connect a different AWS account and send independently.
- Two teams pointed at the **same** AWS account get distinct configuration
  sets and topics, and neither overwrites the other's event destination.
- An SES event posted on team A's topic naming team B's email id is rejected
  and writes nothing.
- Draining team A's send-rate bucket does not affect team B.
- `instance_settings` holds only `signupMode`, `landingEnabled` and
  `retentionDays`; no cloud credentials exist anywhere outside `team_aws` and
  `team_cloudflare`.
- A migrated instance finds its connection on the oldest team, with its legacy
  resource names intact and a banner telling it to reconnect for events.
- `bun run typecheck`, `bun run lint`, `bun run test`, `bun run test:integration`
  and `bun run test:e2e` are all green.
