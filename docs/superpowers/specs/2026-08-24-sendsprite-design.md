# Sendsprite — Design Spec

**Date:** 2026-08-24
**Status:** Approved (brainstorm complete)
**License:** MIT

Sendsprite is a self-hostable, MIT-licensed transactional + marketing email
platform: a Resend / useSend alternative that provisions Amazon SES and
Cloudflare DNS for the user, ships an npm SDK with first-class React support,
and runs from a single `docker compose up`.

Name: **Sendsprite** — npm `sendsprite`, `@sendsprite/mcp`, CLI `npx sendsprite`.
Verified unclaimed on npm, GitHub, `.dev`/`.com`/`.io` on 2026-08-24.

---

## 1. Goals and non-goals

**Goals**

- 1:1 feature parity with useSend, plus: templates with variables, email
  preview/testing, audit log, MCP server.
- Self-host with as little infrastructure knowledge as possible: one
  container + Postgres, browser-driven setup, one-click AWS connection.
- Resend-compatible REST API shapes so migration is a base-URL change.
- Visual language identical to Defyworks `site_v2` / `aws-cost-dashboard`.

**Non-goals (v1)**

- Inbound email (SES receipt rules).
- Multi-region / multiple SES accounts.
- Per-team AWS credentials (instance-level only).
- Client-side React hooks / browser-safe keys.
- Python/Go/PHP SDKs (REST + OpenAPI cover them; ports later).

## 2. Stack

| Concern | Choice |
|---|---|
| Runtime / package manager | Bun |
| Web | Next.js 15 App Router, React 19, Tailwind v4 (`@theme`), Radix primitives, Framer Motion |
| Database | Postgres 16, Drizzle ORM, `drizzle-kit` migrations |
| Jobs / scheduling | pg-boss (Postgres-backed; no Redis) |
| Auth | BetterAuth (Drizzle adapter): Google, GitHub, email/password — each enabled by env presence |
| Email transport | AWS SESv2 SDK; SNS → HTTPS for events |
| DNS | Cloudflare API v4 |
| SMTP relay | `smtp-server` on port 587 |
| Validation / types | zod schemas in `packages/shared`, shared by app and SDK; OpenAPI 3.1 generated from them |
| Tests | Vitest, Testcontainers (Postgres), `aws-sdk-client-mock`, `msw`, Playwright |
| Packaging | Docker (GHCR), `changesets` for npm |

Convex was considered and rejected: a separately hosted Convex backend
defeats the "no infra knowledge" goal.

## 3. Repository layout (Bun workspaces)

```
apps/web              Next.js app: landing, dashboard, docs, REST API, worker, SMTP relay
packages/sdk          npm `sendsprite` (+ `sendsprite/react`, `sendsprite/next`), CLI
packages/mcp          npm `@sendsprite/mcp`
packages/shared       zod schemas, API/webhook types, error codes
infra/aws             CloudFormation quick-create template (sendsprite-connect.yaml)
docker-compose.yml    app + postgres (+ optional profiles)
install.sh            one-line installer
docs/superpowers      specs and plans
```

## 4. Runtime architecture

One `apps/web` container runs, from a custom `server.ts`:

1. **Next.js** — landing, dashboard, docs, `/api/v1/*`, webhook/callback/tracking endpoints.
2. **pg-boss worker** — inline by default (`WORKER_MODE=inline`). `WORKER_MODE=separate` runs the web without a worker; a second replica of the same image runs `bun run worker`.
3. **SMTP relay** — port 587, STARTTLS, auth = any username + API key as password. Feeds the same internal send pipeline. `SMTP_ENABLED=false` disables.

**Database:** Postgres via `DATABASE_URL` (compose service or external). Migrations run on boot (`bun run db:migrate && bun run start`). pg-boss lives in its own schema in the same DB.

**Secrets:** single `APP_SECRET`. AWS keys, Cloudflare token, webhook secrets are stored in Postgres encrypted with AES-256-GCM (key derived from `APP_SECRET` via HKDF). Losing `APP_SECRET` means re-running the connect wizards, not data loss. API keys are stored as SHA-256 hashes only.

**Auth:** `SIGNUP_MODE=open|invite|closed` (default: open until the first user exists, then `invite`). Verification/reset emails for the email/password provider go through Sendsprite itself once a domain is verified; the first user is auto-verified (bootstrap).

**Send pipeline:**

```
POST /api/v1/emails
  → auth (API key) → validate (zod) → suppression check → rate check
  → render (react pre-rendered by SDK | template+variables | html/text)
  → insert emails row (queued|scheduled) → enqueue email.send (delayed if scheduledAt)
worker: email.send
  → SESv2 SendEmail (ConfigurationSet "sendsprite", custom MAIL FROM)
  → store ses_message_id, status=sent, event sent
SES → SNS → POST /api/webhooks/ses (signature verified)
  → email_events (delivered|bounced|complained|delayed|rejected)
  → suppression update (hard bounce, complaint)
  → enqueue webhook.deliver per subscribed team webhook
/t/o/:id (pixel) → opened ; /t/c/:id (redirect) → clicked
```

Per-team token bucket honours SES `MaxSendRate` and daily quota (from `GetAccount`), refreshed hourly. Batch = N rows + N jobs. Scheduled = pg-boss delayed job; cancel/reschedule mutate the job.

Live UI updates: `/api/stream?team=` SSE fed by pg-boss/DB notifications; TanStack Query refetches on message.

## 5. Data model (Drizzle)

Every team-scoped table carries `team_id` with an index. Timestamps `created_at`/`updated_at` everywhere. IDs are prefixed ULIDs (`em_`, `dom_`, `key_`, …) exposed in the API.

**Auth / tenancy**
- BetterAuth tables: `user`, `session`, `account`, `verification`.
- `teams` — name, slug, daily_limit?, monthly_limit?, track_opens, track_clicks.
- `team_members` — team_id, user_id, role `owner|admin|member`.
- `team_invites` — team_id, email, role, token, expires_at, accepted_at.
- `instance_settings` (singleton) — setup_completed, signup_mode, landing_enabled, aws_mode `none|instance_role|keys`, aws_region, aws_access_key_enc, aws_secret_enc, sns_topic_arn, ses_config_set, ses_account_status `sandbox|requested|production`, ses_max_send_rate, ses_daily_quota, cloudflare_token_enc, retention_days.
- `audit_log` — team_id?, actor_user_id?, action, target_type, target_id, diff jsonb, ip, user_agent.

**Sending**
- `domains` — team_id, name (unique instance-wide), region, cloudflare_zone_id?, dns_mode `auto|manual`, status `pending|verified|failed`, dkim_tokens text[], dkim_status, mail_from_domain, mail_from_status, spf_ok, dmarc_ok, expected_records jsonb, last_checked_at, verified_at.
- `api_keys` — team_id, name, key_prefix, key_hash, permission `full|sending_only`, domain_id?, last_used_at, revoked_at.
- `emails` — team_id, api_key_id?, domain_id, from, to text[], cc text[], bcc text[], reply_to text[], subject, html?, text?, headers jsonb, attachments jsonb (metadata), template_id?, variables jsonb?, ses_message_id?, status `queued|scheduled|sent|delivered|bounced|complained|failed|cancelled`, scheduled_at?, sent_at?, idempotency_key? (unique per team), campaign_id?, contact_id?, source `api|smtp|campaign|dashboard`, tags jsonb.
- `email_attachments` — email_id, filename, content_type, size, bytes bytea (purged by retention).
- `email_events` — email_id, type `sent|delivered|delivery_delayed|bounced|complained|rejected|opened|clicked|failed`, payload jsonb.
- `suppressions` — team_id, email, reason `bounce|complaint|manual|unsubscribe`, source_email_id?; unique (team_id, email).

**Webhooks**
- `webhooks` — team_id, url, secret_enc, events text[], enabled, disabled_reason?.
- `webhook_deliveries` — webhook_id, email_event_id?, event_type, payload jsonb, attempt, status_code?, response_excerpt?, next_retry_at?, delivered_at?.

**Templates**
- `templates` — team_id, slug (unique per team), name, subject, body_html, body_text?, variables_schema jsonb, version, updated_by.
- `template_versions` — template_id, version, snapshot jsonb, created_by.

**Audience / campaigns**
- `contact_books` — team_id, name, default_from?.
- `contacts` — book_id, email, first_name?, last_name?, properties jsonb, subscribed, unsubscribe_reason?, unsubscribed_at?; unique (book_id, email).
- `campaigns` — team_id, book_id, domain_id, name, subject, from, reply_to?, content jsonb (block editor), html (rendered), status `draft|scheduled|sending|sent|cancelled`, scheduled_at?, counts jsonb {sent, delivered, opened, clicked, unsubscribed, bounced, complained}.
- `campaign_recipients` — campaign_id, contact_id, email_id?, status.

**Retention:** nightly job purges `emails.html/text` and `email_attachments` older than `retention_days` (default 90). Rows and events remain.

## 6. Provisioning

### 6.1 First-run wizard (`/setup`)

Shown until `instance_settings.setup_completed`; reachable only by the first user (auto-owner of the default team). Re-enterable later from Settings → Instance (owner only).

1. **Account** — sign up with any enabled provider.
2. **Connect AWS** — tried in order:
   - **Instance role**: default credential chain succeeds for `sts:GetCallerIdentity` and `ses:GetAccount` → `aws_mode=instance_role`, no keys stored.
   - **One-click CloudFormation**: button opens the quick-create URL
     `…/cloudformation/home?region=<r>#/stacks/quickcreate?templateURL=<raw template>&stackName=sendsprite-connect&param_CallbackUrl=<APP_URL>/api/setup/aws/callback&param_CallbackToken=<one-time token, 15 min>`.
     Template `infra/aws/sendsprite-connect.yaml` creates: IAM user `sendsprite` with least-privilege inline policy (SES identity/config-set/account read+write, `SendEmail`/`SendRawEmail`, `PutAccountDetails`, SNS create/subscribe/publish scoped to `sendsprite-*`), an access key, SNS topic `sendsprite-events`, and a Lambda-backed custom resource that POSTs `{accessKeyId, secretAccessKey, region, topicArn}` to the callback with the token. The wizard polls `/api/setup/aws/status` until the callback lands. Stack deletion is documented as the disconnect path.
   - **Manual**: paste access key / secret / region.
   Post-connect (any path): create ConfigurationSet `sendsprite` with SNS event destination (all event types), subscribe `<APP_URL>/api/webhooks/ses` (HTTPS; `SubscriptionConfirmation` handled automatically), read `GetAccount` into `instance_settings`.
3. **SES production access** — shows sandbox/production. Form (website, use case, volume, contact) → `PutAccountDetails`; hourly job re-reads status. UI text states AWS reviews manually, typically within 24 hours.
4. **Connect Cloudflare** — deep link to the API token page + card listing required permissions (*Zone → Zone → Read*, *Zone → DNS → Edit*; zone scope: all or selected). Paste → `GET /user/tokens/verify` + `GET /zones`. Optional; skipping = manual DNS.
5. **Done** → dashboard with a setup checklist (add domain, create key, first send).

### 6.2 Domains

`/app/domains/new`: enter name. If a Cloudflare zone is a suffix match, offer **auto**; else **manual**. Job `domain.provision`:

1. `CreateEmailIdentity` (Easy DKIM 2048) with the ConfigurationSet.
2. `PutEmailIdentityMailFromAttributes` → `bounce.<domain>`.
3. Compute expected records: 3× DKIM CNAME; MAIL FROM MX (`feedback-smtp.<region>.amazonses.com`, prio 10) + TXT `v=spf1 include:amazonses.com ~all`; DMARC TXT at `_dmarc.<domain>` = `v=DMARC1; p=none; rua=mailto:dmarc@<domain>` (editable).
4. Auto: upsert via Cloudflare (match on name+type, `proxied=false`). Manual: show table with copy buttons.
5. Schedule `domain.verify` every 2 min for up to 72 h: `GetEmailIdentity` (DKIM, MAIL FROM) + our own DNS resolution for SPF/DMARC. `verified` when DKIM + MAIL FROM verified. Per-record ✓/✗ live in UI; `POST /domains/:id/verify` forces a check.

Delete: `DeleteEmailIdentity`; in auto mode also delete the records Sendsprite created (tracked in `expected_records`). Domain names are unique across the instance.

## 7. REST API (`/api/v1`)

Auth: `Authorization: Bearer ss_live_<32 chars>`. JSON. Cursor pagination (`?limit&cursor`). Rate-limit headers on every response. Errors: `{ "error": { "code", "message", "details"? } }` with stable codes: `validation_error`, `unauthorized`, `forbidden`, `not_found`, `domain_not_verified`, `suppressed_recipient`, `rate_limited`, `daily_quota_exceeded`, `sandbox_restricted`, `idempotency_conflict`, `internal_error`.

| Resource | Endpoints |
|---|---|
| Emails | `POST /emails`, `POST /emails/batch` (≤100), `GET /emails/:id` (includes `events`), `GET /emails`, `PATCH /emails/:id` (`scheduledAt`), `POST /emails/:id/cancel` |
| Domains | `POST /domains`, `GET /domains`, `GET /domains/:id`, `POST /domains/:id/verify`, `DELETE /domains/:id` |
| API keys | `POST`, `GET`, `DELETE /:id` — `full` keys only |
| Templates | `POST`, `GET`, `GET /:slug`, `PATCH /:slug`, `DELETE /:slug`, `POST /:slug/render` |
| Contact books | CRUD; `POST /contact-books/:id/contacts/import` (CSV) |
| Contacts | CRUD under a book; `POST /contacts/unsubscribe` by email |
| Campaigns | CRUD, `POST /:id/schedule`, `POST /:id/send`, `POST /:id/cancel` |
| Webhooks | CRUD, `POST /:id/test` |
| Suppressions | `GET`, `POST`, `DELETE /:email` |

`POST /emails` body:

```json
{
  "from": "Acme <hello@mail.acme.com>",
  "to": ["a@b.com"], "cc": [], "bcc": [], "replyTo": [],
  "subject": "…",
  "html": "…", "text": "…",
  "template": "welcome", "variables": { "name": "Mingu" },
  "headers": { "X-Entity-Ref-ID": "…" },
  "attachments": [{ "filename": "a.pdf", "content": "<base64>", "contentType": "application/pdf" }],
  "scheduledAt": "2026-09-01T09:00:00Z",
  "tags": { "campaign": "onboarding" },
  "idempotencyKey": "order-123"
}
```

Exactly one content source is required: `html`/`text` (either or both), or `template` (+ `variables`). SDK `react` is rendered client-side and arrives as `html`. Response `{ "id": "em_…" }`.

OpenAPI 3.1 generated from `packages/shared` zod schemas at build; served at `/api/v1/openapi.json`, rendered at `/docs/api`.

## 8. Outbound webhooks

`POST <url>` with body `{ "id": "evt_…", "type": "email.delivered", "createdAt": "…", "data": { … } }`.
Headers: `Sendsprite-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>`, `Sendsprite-Event-Id`. Retry schedule 1 m, 5 m, 30 m, 2 h, 8 h; after 24 h of continuous failure the webhook is disabled and team owners are emailed.

Event types: `email.sent|delivered|delayed|bounced|complained|opened|clicked|failed`, `contact.created|updated|unsubscribed|resubscribed`, `domain.verified|failed`, `campaign.sent|completed`.

## 9. SDK, CLI, MCP

**`sendsprite`** (ESM + CJS, Node 18+/Bun/edge; only `fetch`):

```ts
import { Sendsprite } from "sendsprite";
const ss = new Sendsprite(process.env.SENDSPRITE_API_KEY!, { baseUrl: "https://mail.acme.com" });
await ss.emails.send({ from, to, subject, react: <Welcome name="Mingu" /> });
```

Namespaces: `emails`, `domains`, `apiKeys`, `templates`, `contactBooks`, `contacts`, `campaigns`, `webhooks`, `suppressions`. Typed errors (`SendspriteError` with `code`). Automatic retry on 429/5xx with jitter for idempotent calls.

**`sendsprite/react`** — re-exports React Email primitives (`Html, Head, Preview, Body, Container, Section, Row, Column, Text, Heading, Button, Link, Img, Hr`) and `renderEmail(element): Promise<{ html, text }>`. `@react-email/render` is an optional peer dependency; `emails.send({ react })` renders automatically when present.

**`sendsprite/next`** — `createWebhookHandler({ secret, onEvent })` returns an App Router `POST` handler; `verifyWebhook(rawBody, signatureHeader, secret)` for other frameworks. Events typed from `packages/shared`.

**CLI** (`npx sendsprite`): `login`, `whoami`, `domains list`, `emails send`, `emails tail` (SSE), `templates pull|push <dir>`.

**`@sendsprite/mcp`** — stdio + streamable HTTP. Tools: `send_email`, `get_email_status`, `list_emails`, `search_emails`, `list_domains`, `list_templates`, `render_template`, `add_contact`, `get_send_stats`. Env: `SENDSPRITE_API_KEY`, `SENDSPRITE_URL`. Dashboard shows config snippets for Claude Desktop, Claude Code, Cursor.

## 10. Dashboard, landing, theme

**Theme:** `globals.css` `@theme` block copied verbatim from `aws-cost-dashboard` (ink `#000` / indigo scale, Space Grotesk + SUIT self-hosted in `public/fonts`, radii, motion durations/easings, glow/glass shadows), dark-only. UI primitives ported (`Button, Card, Badge, Input, Label, Select, Textarea, Divider, Skeleton, Spinner, Link`) and extended (`Table, Dialog, Sheet, Tabs, Toast, DropdownMenu, CodeBlock, StatusDot, CopyField, EmptyState`) using the same `cn` + variant-map style. App surfaces omit Lenis, cursor ring, and marquees; the landing page keeps them.

**Landing** (`/`, `LANDING_ENABLED=true` default; `false` redirects to `/app`): hero with send snippet + live-typed terminal, "one `docker compose up`" section, feature grid, SDK/React/MCP code tabs, comparison vs Resend/useSend, GitHub + docs CTAs.

**App** (`/app/*`): sidebar (team switcher, nav, sandbox/production pill), top bar (⌘K palette, docs, user menu).

- `/app` overview — sends today/7 d/30 d, delivery/bounce/complaint rates vs SES thresholds, recent emails, domain health, setup checklist.
- `/app/emails` — filterable table; `/[id]` — sandboxed preview, raw HTML/text, headers, event timeline, resend.
- `/app/domains`, `/new`, `/[id]`.
- `/app/api-keys`, `/app/webhooks` (+ delivery log, replay), `/app/suppressions`, `/app/audit`.
- `/app/templates` — code editor with `{{variable}}` autocomplete, live preview with sample variables, version history.
- `/app/contacts` — books, import/export CSV, search, subscription status.
- `/app/campaigns` — block editor (Tiptap + dnd-kit pattern from site_v2, email-safe block set, rendered to table-based HTML), audience, schedule, stats.
- `/app/preview` — paste/upload HTML or pick template → desktop/mobile render, link check, spam score (optional `spamassassin` compose profile), send test to self.
- `/app/settings` — team (name, members, invites, tracking defaults, limits), profile; **Instance** tab (owner): AWS/Cloudflare, SES production request, signup mode, landing toggle, retention.
- `/setup`, `/docs` (MDX: quickstart, self-hosting, SDK, API, MCP, SMTP), `/unsubscribe/:token`, `/t/o/:id`, `/t/c/:id`.

Strings live in a `{ en, ko? }` dictionary from day one (site_v2 convention); only `en` is authored in v1.

## 11. Self-hosting

- `docker-compose.yml`: `app` (`ghcr.io/defyworks/sendsprite`, ports 3000 + 587, healthcheck `/api/health`, `restart: unless-stopped`) + `postgres:16` with named volume. Profiles: `spamassassin`, `worker`.
- `install.sh` — checks Docker, writes `.env` (`APP_SECRET`, `POSTGRES_PASSWORD` generated; prompts only for `APP_URL`), `docker compose up -d`, prints the setup URL.
- Env reference: `APP_URL`, `APP_SECRET`, `DATABASE_URL`, `WORKER_MODE`, `SMTP_ENABLED`, `LANDING_ENABLED`, `SIGNUP_MODE`, `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, `EMAIL_PASSWORD_ENABLED`, `EMAIL_RETENTION_DAYS`. No `NEXT_PUBLIC_*` — one image serves any hostname.
- Coolify template; Railway/Render buttons later. Dockerfile follows the `site_v2` multistage Bun pattern.
- Scripts: `dev`, `build`, `start`, `worker`, `typecheck`, `lint`, `format`, `test`, `test:e2e`, `db:migrate`, `db:studio`, `db:generate`.

## 12. Error handling

- SES throttling / 5xx → pg-boss retry (5 attempts, exponential backoff) → `failed` event + webhook. `MessageRejected` / sandbox-only → immediate `failed` with a specific code, no retry.
- Suppressed recipients rejected at API time (`suppressed_recipient`); `manual`-reason suppressions can be overridden per request with `overrideSuppression: true`.
- AWS/Cloudflare calls return typed errors surfaced verbatim in the UI (e.g. token lacking DNS:Edit on a zone). Provisioning jobs are idempotent and re-runnable.
- Inbound SNS: signature verified against the `sns.amazonaws.com` cert URL allow-list; unknown message IDs logged at info, 200 returned.
- `/api/health` reports DB, queue lag, SES connectivity, sandbox status. Bounce ≥ 4 % or complaint ≥ 0.08 % (rolling 24 h) triggers owner email + banner.

## 13. Testing

- **Unit (Vitest):** send pipeline, token bucket, HMAC signing/verification, template rendering, DNS record computation, suppression rules, retention purge selection.
- **Integration (Testcontainers Postgres):** API routes end-to-end with SES/Cloudflare mocked (`aws-sdk-client-mock`, `msw`); SMTP relay via `nodemailer` against the local server; webhook delivery + retries; SNS ingestion.
- **E2E (Playwright):** setup wizard (manual AWS path), add domain (mocked), dashboard send, webhook delivery.
- **SDK:** contract tests against the generated OpenAPI spec. **MCP:** tool schema snapshots.
- **CI (GitHub Actions):** typecheck, lint, unit + integration, Docker build; `changesets` publish `sendsprite` and `@sendsprite/mcp` with `NPM_TOKEN`; GHCR image on tag.

## 14. Delivery order

Each phase gets its own implementation plan under `docs/superpowers/plans/`.

1. **Foundation** — monorepo, theme + UI primitives, BetterAuth, teams/invites, schema + migrations, compose + Dockerfile + installer, app shell, health endpoint.
2. **Provisioning** — setup wizard, CloudFormation template + callback, instance-role detection, Cloudflare connect, domains provision/verify.
3. **Sending** — REST API, queue + worker, SES send, SNS ingestion, events, suppressions, webhooks, email log UI, tracking, SMTP relay.
4. **Developer surface** — SDK (+ react, next), CLI, MCP, OpenAPI + docs site, landing page.
5. **Growth features** — templates + versions, preview/testing, contacts + import, campaigns editor, audit log, analytics overview.
