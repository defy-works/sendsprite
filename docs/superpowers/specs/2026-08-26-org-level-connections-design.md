# Org-level AWS and Cloudflare connections

**Date:** 2026-08-26
**Status:** approved, not yet implemented

## Problem

Every deployment has exactly one AWS account. `instance_settings` is a
singleton (`id = 1`, enforced by a check constraint) holding the AWS mode,
region, encrypted keys, SES account status and quotas, the SNS topic ARN and
the Cloudflare OAuth grant. `resolveAwsContext()` takes no arguments.
`send_rate_state` is a singleton token bucket. `/api/webhooks/ses` authorises
by comparing the incoming `TopicArn` to the one stored ARN.

That is a single-tenant control plane wearing a multi-tenant schema: teams
already own domains, emails, billing and settings, but they all send through
one operator-owned AWS account.

Two changes follow from that:

1. **AWS and Cloudflare become team-owned.** Each team connects its own AWS
   account and its own Cloudflare account. The instance holds no cloud
   credentials of any kind.
2. **Instance-operator settings get their own page.** Signup mode, the landing
   page toggle and the retention ceiling are operator concerns, not tenant
   concerns, and move behind an instance-admin gate.

## Decisions

| Question | Decision |
| --- | --- |
| Tenancy | Each org owns its AWS account. The instance owns none. |
| SNS routing | Team-scoped webhook path, `/api/webhooks/ses/[teamId]`. |
| Instance admin | `INSTANCE_ADMIN_EMAILS` env var **and** a `user.instance_admin` column. |
| Page shape | `/setup` becomes team-scoped; `/app/settings/instance` becomes `/app/settings/sending`; new `/app/admin`. |
| Retention | Per team, with the instance value as a ceiling. |
| Who connects | Team owner **or** admin. |

## Data model

### `instance_settings` (singleton, retained)

Keeps only operator-scoped columns:

- `signupMode`, `landingEnabled`
- `retentionDays` — **reinterpreted as the maximum** a team may choose
- `setupCompleted` is removed (it becomes per team)

All `aws*`, `ses*`, `sns*` and `cloudflare*` columns are dropped.

### `team_aws` (new)

`teamId` primary key referencing `organization.id` with `on delete cascade`.

`region`, `accessKeyEnc`, `secretEnc`, `accountId`, `connectedAt`,
`configSet`, `snsTopicArn` (unique), `snsSubscriptionArn`, `sesAccountStatus`,
`sesReviewStatus`, `sesDailyQuota`, `sesMaxSendRate`, `sesLastCheckedAt`,
`createdAt`, `updatedAt`.

**The presence of the row is the connection.** `awsMode = "none"` disappears;
`getTeamAws(teamId)` returns `null` and every current `awsMode === "none"`
check becomes a null check.

**`mode: "instance_role"` is dropped, and with it the `mode` column.** The
mode meant "whatever the SDK's default credential chain finds on this host" —
one process has one ambient identity, so it can only ever serve one tenant.
Keeping it would mean a special case on every resolution path for exactly one
team. Self-hosters relying on a host role reconnect with an IAM user; the
CloudFormation quick-create already mints one.

With `instance_role` gone, `keys` is the only remaining mode, so a `mode`
column would be a single-valued enum carrying no information.
`accessKeyEnc` and `secretEnc` are therefore `not null`, and
`resolveAwsContext` never has to branch on how to build credentials.

### `team_cloudflare` (new)

`teamId` primary key, cascade. `accessTokenEnc`, `refreshTokenEnc`,
`tokenExpiresAt`, `accountName`, `connectedAt`, `createdAt`, `updatedAt`.

Two narrow tables rather than one wide row: each has one job, and
disconnecting is a row delete rather than nulling eight columns.

### `team_settings` (extended)

Gains `setupCompleted` (boolean, default false) and `retentionDays`
(nullable integer). Effective retention for a team is
`min(team.retentionDays ?? instanceMax, instanceMax)` — a team may only
shorten its window, never extend past what the operator allows.

### `team_send_rate` (replaces `send_rate_state`)

`teamId` primary key, `tokens`, `refilledAt`. The old table is a singleton
bucket for an account-wide SES `MaxSendRate` that is now per tenant. Buckets
are ephemeral, so the migration drops and recreates rather than backfilling.

Besides correctness this removes a cross-tenant coupling: today one team's
volume can exhaust the bucket every other team draws from.

### `user` (extended)

Gains `instanceAdmin` boolean, not null, default false.

### `setup_tokens` (extended)

Gains `teamId` (cascade). The CloudFormation callback reads the team off the
token rather than inferring it, so a stack created for team A cannot connect
into team B even with a valid token.

## Admin identity and gates

`lib/session.ts` ends up with three gates:

- `requireTeam()` — unchanged.
- `requireTeamAdmin()` — replaces `requireOwner()`. Owner **or** admin of the
  *active* team. Gates `/setup` and `/app/settings/sending`.
- `requireInstanceAdmin()` — passes when `INSTANCE_ADMIN_EMAILS` contains the
  session email (case-insensitive, comma-separated) **or** `user.instanceAdmin`
  is true. Gates `/app/admin` only.

The env var is an escape hatch that always works and cannot be revoked from
the UI; the column is what the admin page toggles. `env.schema.ts` gains
`INSTANCE_ADMIN_EMAILS` as an optional comma-separated string.

The signup hook in `lib/auth.ts` already counts users to resolve signup mode.
When that count is zero **and** `INSTANCE_ADMIN_EMAILS` is empty, it sets
`instanceAdmin` on the new user in the same path. The existing race-window
caveat on first signup is unchanged and equally acceptable here.

## Service layer

`services/instance-settings.ts` splits:

- **`services/team-aws.ts`** — `getTeamAws`, `updateTeamAws`,
  `getTeamAwsSecrets`, `disconnectTeamAws`. Same audit-diff shape as today
  (`computeDiff`, ciphertext compared so a rotation still registers, secrets
  redacted by key name).
- **`services/instance-settings.ts`** — slimmed to the three operator columns.

Cloudflare connection state folds into the existing
`services/cloudflare-connect.ts` alongside `beginOauth` / `completeOauth`,
which all gain a `teamId`.

`resolveAwsContext(teamId)` is the single signature change that propagates
through `ses-send.ts`, `domains.ts`, `aws-connect.ts` and the SNS route.
TypeScript surfaces every call site.

Audit rows for connect and disconnect now carry the real `teamId` instead of
`null`. Only the `/app/admin` form writes `teamId: null`.

## Flows

### Setup

`/setup` keeps its four steps (`aws` → `production` → `cloudflare` → `done`)
but resolves the active team and gates on `requireTeamAdmin()`. Every team
walks it.

`app/app/layout.tsx` redirects on `team_settings.setupCompleted`: owner or
admin → `/setup`, member → `/waiting`.

`listOwnerEmails` narrows to the caller's **active team** and drops its
instance-wide fallback. With per-team AWS, an owner of an unrelated team
cannot help you finish setup, so listing them is misleading.

### CloudFormation quick-create

No change to `infra/aws/sendsprite-connect.yaml`. The template only mints an
IAM user and POSTs the keys to `CallbackUrl`; the SNS topic, configuration set
and subscription are all created by our own code.

`startQuickCreate` stamps the active team on the issued token.
`app/api/setup/aws/callback/route.ts` passes `tok.teamId` to `connectWithKeys`.
`app/api/setup/aws/status/route.ts` becomes team-scoped.

### AWS resource naming (org slug)

Nothing stops one person connecting two orgs to the **same** AWS account, so
the three fixed names must carry the org slug:

| Today | Becomes |
| --- | --- |
| `stackName: "sendsprite-connect"` | `sendsprite-connect-<slug>` |
| `CONFIG_SET = "sendsprite"` | `sendsprite-<slug>` |
| `TOPIC_NAME = "sendsprite-events"` | `sendsprite-events-<slug>` |

`EVENT_DESTINATION` stays fixed: it is scoped inside the configuration set,
which is now unique.

Without this, two orgs on one AWS account share a configuration set, so
`CreateConfigurationSetEventDestination` takes its `AlreadyExists` branch and
**updates** the destination — silently repointing org A's SES events at org
B's SNS topic. That is a cross-tenant event leak, not merely a name clash.
Sharing the topic is the milder failure: `CreateTopic` is idempotent by name,
so the second team's connect dies on the `snsTopicArn` unique constraint.

**The template still needs no change.** `SendspriteUser` is already
`!Sub "sendsprite-${AWS::StackName}"`, so a slugged stack name makes the IAM
user unique for free, and the SNS policy resource `sendsprite-*` still matches
a slugged topic ARN.

**Slug sanitising.** The three services disagree on legal characters
(CloudFormation stack names are `[A-Za-z][A-Za-z0-9-]*`, SES configuration
set names allow `_`, SNS topic names allow `_` too). A single
`awsResourceSuffix(slug)` in `lib/aws/naming.ts` lowercases, replaces anything
outside `[a-z0-9-]` with `-`, collapses runs, trims leading and trailing
hyphens and caps the result at 40 characters, so one derivation feeds all
three names and the shortest limit governs.

**Slugs are mutable; these names are not.** `organization.slug` can change
after a connect. The names chosen at connect time are already persisted
(`team_aws.configSet`, `team_aws.snsTopicArn`), so every later read — creating
a domain identity, ingesting events — uses the stored value and **never**
re-derives from the current slug. Re-deriving would silently address a
configuration set that no longer exists. A team that renames and then
*reconnects* gets fresh resources and leaves the old ones behind in its own
AWS account, where they are visible and deletable; that is accepted rather
than chased.

### SNS ingress

`subscribeEndpoint` builds `${APP_URL}/api/webhooks/ses/${teamId}`.

The route moves to `app/api/webhooks/ses/[teamId]/route.ts` and authorises in
two steps:

1. Load `team_aws` for the team named in the path; 403 when absent.
2. Require `msg.TopicArn === row.snsTopicArn`; 403 otherwise.

Both must hold. The path alone is guessable; the ARN alone is the old global
check. `confirmSubscription` resolves credentials for that team.
`SubscriptionConfirmation` and `UnsubscribeConfirmation` write
`snsSubscriptionArn` on that team's row.

The existing ordering guarantee is preserved: `finishConnect` persists
`snsTopicArn` before calling `Subscribe`, so a confirmation POST that races
the `Subscribe` response still finds the ARN.

### Cross-tenant ingest (security)

`ingestSesEvent` currently resolves an email by the `ss_email` tag, falling
back to `ses_message_id`, **with no team predicate**. Under one AWS account
that is harmless. With N tenant accounts POSTing to us, tenant A could craft
an SES event carrying tenant B's `ss_email` and write timeline events, status
changes and suppressions into B's data.

`ingestSesEvent` therefore takes `teamId` as its first argument and **both**
lookups gain `and(eq(emails.teamId, teamId), …)`. An event that does not match
a row owned by the posting team is rejected as `unknown_email`.

### Sending

- `takeSesToken(teamId)` against `team_send_rate`.
- `checkInstanceQuota` becomes `checkAccountQuota(teamId, adding)`, counting
  only that team's sends in the trailing 24 h.
- `usageSnapshot` renames `instanceQuota` / `instanceUsed` to `accountQuota` /
  `accountUsed`. The public `x-ratelimit-*` header names in
  `lib/api-response.ts` are unchanged.
- The `capped ? 0 : …` shortcut in `usageSnapshot` is removed, along with the
  compensating comment in `app/app/campaigns/send.ts` warning readers not to
  believe `instanceUsed: 0`. Team-scoped, the count is a cheap indexed query.

### Jobs

- `ses-refresh-account` iterates teams holding a `team_aws` row, each inside
  its own try/catch, so one tenant's expired keys cannot kill the tick.
- `retention-purge` iterates teams and purges each at
  `min(team.retentionDays ?? max, max)`. `purgeOldBodies` takes a `teamId`.

### Pages

| Route | Gate | Contents |
| --- | --- | --- |
| `/setup` | `requireTeamAdmin` | Team wizard, four steps, unchanged shape |
| `/app/settings/sending` | `requireTeamAdmin` | AWS + production + Cloudflare steps in `settings` mode |
| `/app/admin` | `requireInstanceAdmin` | Signup mode, landing page, retention ceiling |

`/app/settings/instance` redirects to `/app/settings/sending`.

### Copy

`"Connect AWS first (Settings → Instance)"` becomes `(Settings → Sending)`.
`app/docs/domains/page.mdx` and `app/docs/self-hosting/page.mdx` get the same
correction, plus a note that each team connects its own AWS account.

## Migration

Three numbered migrations. They are split because `drizzle-kit generate`
prompts for a TTY when a single diff both drops and adds columns on one table
— a known trap recorded in the project's Do-Not-Repeat list.

**0019 — additive.** Create `team_aws`, `team_cloudflare`, `team_send_rate`.
Add `user.instance_admin`, `setup_tokens.team_id`,
`team_settings.setup_completed`, `team_settings.retention_days`.

**0020 — data move.** Hand-written SQL targeting the **oldest organization by
`created_at`**:

- Insert one `team_aws` row from `instance_settings` when `aws_mode <> 'none'`,
  mapping `instance_role` to `keys` is *not* possible, so an `instance_role`
  instance is migrated with its row omitted and must reconnect. This is called
  out in the release note.
- Insert one `team_cloudflare` row when `cloudflare_connected_at` is not null.
- Copy `setup_completed` onto that team's `team_settings` row.
- Set `instance_admin = true` on the oldest user by `created_at`.

Ciphertext is copied verbatim — same encryption key, no re-encryption.
With zero organizations every statement is a no-op and the operator
reconnects through the wizard.

The migrated team keeps the **legacy unslugged names** (`sendsprite`,
`sendsprite-events`) because they are copied from the singleton, and every
read uses the stored value. Do not rename them during migration: the
configuration set and topic already exist in that AWS account under the old
names, and renaming the DB column would address resources that are not there.
Only a fresh connect produces slugged names.

**0021 — destructive.** Drop the moved columns from `instance_settings`; drop
`send_rate_state`.

### What migration cannot carry

The live SNS subscription points at `/api/webhooks/ses`, and the new route is
team-scoped. A migrated instance therefore has `snsTopicArn` set and a
subscription that no longer resolves.

`/setup` shows a "reconnect to resume event delivery" banner when a team has
`snsTopicArn` but no `snsSubscriptionArn` — the same shape as the existing
subscribe-failure warning, so no new UI concept is introduced.

## Testing

The integration suite drives `updateInstanceSettings` as a fixture from
roughly fourteen files. Those calls are replaced by a
`connectTeamAws(teamId, patch)` helper in `tests/helpers` rather than renamed
in place, so intent reads correctly and the next signature change touches one
file.

New coverage:

- **Cross-tenant ingest.** An event posted on team A's topic carrying team B's
  `ss_email` is rejected; no event, status change or suppression is written.
- **Webhook authorisation.** Wrong `teamId` in the path, or a `TopicArn` that
  does not match the path's team, both 403.
- **Per-team rate buckets.** Draining team A's bucket leaves team B's full.
- **Per-team quota.** `checkAccountQuota` counts only the calling team.
- **`requireInstanceAdmin`.** Allows an env-listed email and a flagged user;
  refuses a plain team owner.
- **First-signup flag.** Set when `INSTANCE_ADMIN_EMAILS` is empty, not set
  when it is populated.
- **Resource naming.** `awsResourceSuffix` lowercases, strips illegal
  characters, collapses hyphen runs and caps at 40; a slug of `Acme_Corp!!`
  and one of `acme-corp` both yield a stack name CloudFormation accepts.
- **Two orgs, one AWS account.** Connecting both produces distinct
  configuration sets and distinct topic ARNs, and neither connect overwrites
  the other's event destination.
- **Slug rename.** Renaming a team after connecting leaves `configSet` and
  `snsTopicArn` untouched, and creating a domain afterwards still uses the
  stored configuration set name.
- **Migration 0020.** Seeded pre-migration singleton lands on the oldest org.
- **Retention ceiling.** A team asking for more than the instance maximum is
  clamped.

`tests/e2e/setup.spec.ts` covers the team-scoped wizard and a second team
walking it independently of the first.

## Out of scope

- Changing the CloudFormation template.
- Any per-team override of `signupMode` or `landingEnabled`.
- Migrating more than one organization's worth of AWS state (there is only
  ever one instance connection to move).
- Cloudflare OAuth client registration, which remains a separate open item.
