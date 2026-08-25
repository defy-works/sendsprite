# Sendsprite

Self-hosted email API and marketing platform on Amazon SES. A Resend / useSend
alternative that sets up SES and Cloudflare DNS for you, ships an npm SDK with
first-class React support, and runs from a single `docker compose up`.

Bun · Next.js 16 · Postgres · Drizzle · pg-boss · BetterAuth · MIT

## Install (self-host)

```bash
curl -fsSL https://sendsprite.dev/install.sh | sh
```

That writes `~/sendsprite/.env` with generated secrets, starts the app and
Postgres, and prints the signup URL. The first account becomes the instance
owner; after that, sign-ups are invite-only unless you change `SIGNUP_MODE`.

Manual alternative: copy `.env.example` to `.env`, set `APP_URL`, `APP_SECRET`
(≥ 32 random chars) and `POSTGRES_PASSWORD`, then `docker compose up -d`.

## Why it works the way it does

**One container, one database.** Everything — web, REST API, background jobs,
SMTP relay — runs in the Next.js process. Jobs use pg-boss on the same Postgres,
so there is no Redis and no second service to operate. When you outgrow one
box, set `WORKER_MODE=separate` on `app` and start the `worker` compose
profile: it runs the same image with `WORKER_MODE=inline` and no published
port, so jobs move to that replica while `app` only serves HTTP.
(`bun run worker` is for non-Docker installs; the standalone image has no
`src/`.)

**Secrets never live in env.** AWS keys and the Cloudflare token are entered in
the browser and stored encrypted (AES-256-GCM, key derived from `APP_SECRET`).
Losing `APP_SECRET` means re-connecting AWS/Cloudflare, not losing data.

**Auth providers are switched on by presence.** Set `GOOGLE_CLIENT_ID` +
`GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`, and/or
`EMAIL_PASSWORD_ENABLED=true`. Nothing else to configure.

**Migrations run on boot.** The image applies pending migrations before it
serves traffic, so upgrading is `docker compose pull && docker compose up -d`.

## Connect AWS & Cloudflare

The first owner lands in a setup wizard (`/setup`); every step is re-enterable
later from Settings → Instance (owners only). AWS can be skipped during setup,
but domains cannot be added until it is connected.

**AWS — three paths, same result.**

- **Instance role.** If the container already has AWS credentials (EC2/ECS
  role, `AWS_PROFILE`, …) that pass `sts:GetCallerIdentity` and
  `ses:GetAccount`, the wizard detects it and stores no keys.
- **One-click CloudFormation.** Opens a quick-create link for
  `infra/aws/sendsprite-connect.yaml`. The stack creates a least-privilege IAM
  user; a Lambda inside the stack creates the access key and POSTs it once to
  `<APP_URL>/api/setup/aws/callback` with a single-use token (15 minutes), so
  the secret never enters CloudFormation state. Requires a public `https://`
  `APP_URL`. Quick-create only accepts S3 template URLs, so the link points at
  `CFN_TEMPLATE_URL` (our public bucket by default; point it at your own copy
  if you prefer). Delete the stack to revoke access. Details in
  [`infra/aws/README.md`](infra/aws/README.md).
- **Manual.** Paste an access key, secret and SES region.

After any path Sendsprite creates the `sendsprite` configuration set, the
`sendsprite-events` SNS topic and an HTTPS subscription to
`<APP_URL>/api/webhooks/ses` (confirmed automatically through the SNS SDK with
`AuthenticateOnUnsubscribe` — the one-click policy grants
`sns:ConfirmSubscription` for that; without it the webhook falls back to the
plain SubscribeURL confirm), and reads your account status and quota.

**Webhooks.** Endpoint URLs must be public https addresses: `localhost`,
`*.local`/`*.internal`, single-label hosts and loopback, private (RFC 1918),
link-local (incl. `169.254.169.254`), CGNAT and IPv6 ULA/link-local literals
are rejected, redirects are not followed and replies are read up to 500 bytes.
Failed deliveries retry after 1 m, 5 m, 30 m, 2 h and 8 h; a once-a-minute
sweep enqueues the ones that are due, so a `nextRetryAt` is a floor rather
than an exact time.
The check is syntactic: a public name that resolves to a private address
(DNS rebinding) is not caught, so run the worker in a network segment that
cannot reach internal services.

**Sandbox.** New SES accounts start in the sandbox: you can only send to
verified addresses and at a low quota. The wizard's production step submits
the request (`PutAccountDetails`: website, use case, expected volume) and an
hourly job re-checks the review status; AWS reviews manually, typically within
a day.

**Cloudflare (optional).** Create an API token at
`dash.cloudflare.com/profile/api-tokens` with _Zone → Zone → Read_ and
_Zone → DNS → Edit_ (all zones, or just the ones you will send from) and paste
it. With Cloudflare connected, domains whose zone is visible get their DNS
records written automatically (**auto** mode). Without it — or for domains
outside your Cloudflare zones — the domain page lists the records to add by
hand (**manual** mode). A token that sees zero zones still connects, with a
warning to add Zone:Read.

**Domain verification.** Adding a domain creates the SES identity (Easy DKIM 2048) with `bounce.<domain>` as MAIL FROM and computes the expected records:
three DKIM CNAMEs, MAIL FROM MX + SPF TXT, and a DMARC TXT at `_dmarc.<domain>`
(`v=DMARC1; p=none` by default, no `rua`). SPF and DMARC are one-per-name, so in
auto mode an existing `v=spf1`/`v=DMARC1` record at that name is updated rather
than duplicated. A per-domain job then checks every 2 minutes for up to 72
hours (first check after 30 s) — DKIM and MAIL FROM via SES, SPF and DMARC via
public resolvers (`1.1.1.1`, `8.8.8.8`; the container needs outbound UDP/TCP 53) — and marks the domain `verified` once DKIM and MAIL FROM are. The domain
page shows per-record ✓/✗ and a **Re-verify** button that restarts the window.

## Sending

Sending needs a **verified domain** and an **API key** (Team → API keys; the
secret `ss_live_…` is shown once; `sending_only` keys can only call
`POST /api/v1/emails*`, and a key can be pinned to one domain). Every REST call
is `Authorization: Bearer ss_live_…` with a JSON body.

```bash
curl -X POST "$APP_URL/api/v1/emails" \
  -H "Authorization: Bearer ss_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Acme <hello@mail.acme.com>",
    "to": ["a@example.com"],
    "subject": "Hello",
    "html": "<p>Hi <a href=\"https://acme.com\">there</a></p>",
    "text": "Hi there",
    "replyTo": ["support@acme.com"],
    "headers": { "X-Entity-Ref-ID": "order-123" },
    "tags": { "campaign": "onboarding" },
    "attachments": [{ "filename": "invoice.pdf", "content": "<base64>", "contentType": "application/pdf" }],
    "scheduledAt": "2026-09-01T09:00:00Z",
    "idempotencyKey": "order-123",
    "trackOpens": true,
    "trackClicks": false
  }'
# → 201 {"id":"em_…"}  (200 with the earlier id on an idempotent replay)
```

- **Content:** `html` and/or `text` (≤ 5 MB each). `template`/`variables` are
  accepted by the schema but templates ship in Phase 5. Up to 50 recipients
  across `to`/`cc`/`bcc`; custom headers may not set the envelope headers
  (`From`, `To`, `Return-Path`, `DKIM-Signature`, …); at most 20 tags.
- **Batch:** `POST /api/v1/emails/batch` with an array of ≤ 100 messages →
  `201 { "data": [{ "id" }] }`. Items are created in order; on the first
  failure the response is that item's error with `details.index`, and the
  earlier items stay queued.
- **Scheduling:** `scheduledAt` (ISO 8601, in the future) creates the email
  as `scheduled`; `PATCH /api/v1/emails/:id { "scheduledAt" }` moves it and
  `POST /api/v1/emails/:id/cancel` cancels anything still `queued`/`scheduled`.
- **Idempotency:** `idempotencyKey` (≤ 256 chars, per team) replays the same
  request with the earlier id; a different payload under the same key is
  `409 idempotency_conflict`.
- **Attachments:** base64 `content`, ≤ 10 MB each, sent as SESv2 attachments;
  the request body is capped at 25 MB (`413 payload_too_large`).
- **Tracking:** Sendsprite rewrites links to `/t/c/:id?u=…&s=<hmac>` and adds
  a pixel at `/t/o/:id.gif`; the team defaults (`team_settings.track_opens`
  / `track_clicks`, on by default; no dashboard control yet) are overridable
  per request with `trackOpens`/`trackClicks`. SES's own open/click tracking
  is disabled so each count has one source.
- **Read back:** `GET /api/v1/emails/:id` (includes `events`),
  `GET /api/v1/emails?limit&cursor&status&to&domainId&tag`.

### Webhooks

Team → Webhooks (or `POST /api/v1/webhooks { url, events }`) subscribes a URL
to `email.sent|delivered|delayed|bounced|complained|opened|clicked|failed`
and `domain.verified|failed`; the `whsec_…` secret is shown once. Deliveries
are `POST { id, type, createdAt, data }` with `Sendsprite-Signature:
t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<body>")>` and
`Sendsprite-Event-Id`. Failures retry after 1 m, 5 m, 30 m, 2 h and 8 h
(driven by a once-a-minute sweep); a webhook failing continuously for 24 h is
disabled (the reason shows on Team → Webhooks; re-enable it there).
`POST /api/v1/webhooks/:id/test` sends a synthetic event. Verify signatures
with the pure helper from `@sendsprite/shared` (the `sendsprite` SDK wraps it
in Phase 4):

```ts
import { verifyWebhookSignature } from "@sendsprite/shared";

app.post("/hooks/sendsprite", express.raw({ type: "*/*" }), (req, res) => {
  const ok = verifyWebhookSignature(
    req.body.toString("utf8"), // the raw body, exactly as received
    req.header("sendsprite-signature") ?? "",
    process.env.SENDSPRITE_WEBHOOK_SECRET!,
  ); // 5-minute timestamp tolerance, constant-time compare
  if (!ok) return res.status(400).end();
  const event = JSON.parse(req.body);
  res.status(204).end();
});
```

### SMTP relay

Port 587 (`SMTP_PORT`), STARTTLS, `AUTH PLAIN`/`LOGIN` with **any username and
an API key as the password**. Messages are parsed and go through the same
pipeline as the API (`source: smtp`; `bcc` = envelope recipients not in
`To`/`Cc`). Without `SMTP_TLS_CERT`/`SMTP_TLS_KEY` the relay uses a self-signed
certificate generated at boot, so clients must skip verification (nodemailer:
`tls: { rejectUnauthorized: false }`); put real PEM files there for
production. AUTH is refused on a plain connection unless
`SMTP_ALLOW_INSECURE_AUTH=true` (development only — the key travels in clear).
Refusals map to SMTP codes (invalid key 535, unverified domain / suppressed
recipient 550, quota 452, too large 552, max 10 MB by default). Login
throttling is per remote IP (5 failures → 10-minute lockout): behind a proxy
that does not speak PROXY protocol every client shares one counter, so expose
587 directly or terminate it on the app container.

### Suppressions, limits, errors, retention

- **Suppressions** (Team → Suppressions; `GET/POST /api/v1/suppressions`,
  `DELETE /api/v1/suppressions/:email`): hard bounces and complaints are added
  automatically from the SES feed (`bounce`/`complaint`; a `not-spam`
  complaint is a retraction and does not suppress); `manual`/`unsubscribe`
  entries are yours. Sends to a suppressed address fail with
  `422 suppressed_recipient`; `manual` entries can be bypassed per request
  with `overrideSuppression: true`.
- **Limits:** one instance-wide token bucket at SES `MaxSendRate` (a throttled
  job re-queues itself, nothing is dropped) plus optional per-team daily and
  monthly caps (`team_settings.daily_limit` / `monthly_limit`, unset by
  default; UTC calendar windows → `429 daily_quota_exceeded` /
  `monthly_quota_exceeded`). Email responses
  carry `x-ratelimit-limit` and `x-ratelimit-remaining` (the team daily cap,
  else the SES 24 h quota, else `unlimited`); `x-ratelimit-reset` (next UTC
  midnight) is present only with a team daily cap.
- **Errors:** `{ "error": { "code", "message", "details"? } }` with codes
  `validation_error` 400, `unauthorized` 401, `forbidden` 403, `not_found`
  404, `idempotency_conflict`/`conflict` 409, `payload_too_large` 413,
  `domain_not_verified`/`suppressed_recipient`/`sandbox_restricted` 422,
  `rate_limited`/`daily_quota_exceeded`/`monthly_quota_exceeded` 429,
  `internal_error` 500. SES throttling and 5xx retry up to 5 times with
  backoff, then the email is `failed` (event + webhook); `MessageRejected` and
  sandbox refusals fail at once.
- **Retention:** bodies and attachments are purged nightly after
  `retention_days` (Settings → Instance, default 90); metadata and events stay.
  The overview shows bounce ≥ 4 % / complaint ≥ 0.08 % banners (rolling 24 h,
  after 20 sends) and the email log streams updates over SSE.

## Development

```bash
bun install
bun run --filter @sendsprite/web db:dev   # embedded Postgres 16 in apps/web/.pgdata (no Docker needed); or point DATABASE_URL at your own
cp .env.example apps/web/.env.local
bun run db:migrate
bun dev                      # http://localhost:3000
```

```bash
bun run typecheck            # next typegen + tsc, every workspace
bun run lint · format · format:check
bun run test                 # unit (vitest)
bun run test:integration     # vitest against an embedded Postgres (or TEST_DATABASE_URL)
bun run test:e2e             # Playwright
bun run db:generate          # new migration from schema changes
```

CI builds the image (see `.github/workflows/ci.yml`); `docker compose build`
does the same locally.

## Environment reference

| Variable                                             | Default       | Notes                                                                       |
| ---------------------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| `APP_URL`                                            | —             | Public URL, with protocol                                                   |
| `APP_SECRET`                                         | —             | ≥ 32 chars; encrypts stored credentials                                     |
| `DATABASE_URL`                                       | —             | Postgres connection string                                                  |
| `POSTGRES_PASSWORD`                                  | —             | Compose only; alphanumeric recommended (interpolated unencoded into URL)    |
| `SIGNUP_MODE`                                        | `auto`        | `auto` → open until first user, then invite; or `open`/`invite`/`closed`    |
| `EMAIL_PASSWORD_ENABLED`                             | `false`       | Email + password sign-in                                                    |
| `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` | —             | OAuth providers                                                             |
| `WORKER_MODE`                                        | `inline`      | `inline` / `separate` / `none`                                              |
| `SMTP_ENABLED`                                       | `true`        | SMTP relay (username anything, password = API key); AUTH requires STARTTLS  |
| `SMTP_ALLOW_INSECURE_AUTH`                           | `false`       | Dev only: accept AUTH on a plain connection (the API key travels in clear)  |
| `SMTP_PORT`                                          | `587`         | Relay port inside the container; compose maps it to the same host port      |
| `SMTP_TLS_CERT`, `SMTP_TLS_KEY`                      | —             | PEM paths for STARTTLS; unset → self-signed cert (clients must skip verify) |
| `SMTP_MAX_SIZE`                                      | `10485760`    | Max message size in bytes (552 above it)                                    |
| `LANDING_ENABLED`                                    | `true`        | `false` sends `/` to `/app`                                                 |
| `AWS_DEFAULT_REGION`                                 | `us-east-1`   | Region preselected in the AWS connect wizard                                |
| `CFN_TEMPLATE_URL`                                   | Sendsprite S3 | S3 URL of the one-click CloudFormation template (must be S3)                |
| `AWS_E2E_MOCK`                                       | —             | `1` swaps AWS clients for an in-memory fake; ignored in production (tests)  |
| `AWS_E2E_VERIFY`                                     | —             | With the fake: `1` reports DKIM/MAIL FROM as SUCCESS (dev/test only)        |

SMTP login throttling is per remote IP (5 failed logins → 10 minute lockout)
and per process. Behind a proxy or load balancer that does not speak PROXY
protocol, every client arrives from the proxy's address and shares one
counter, so expose 587 directly or terminate it on the app container.

Email body/attachment retention has no env var: the window (default 90 days)
is set in Settings → Instance (`retention_days`) and applied by the nightly
`retention.purge` job (03:15), which also drops webhook deliveries older than
the window.

Settings → Instance can override two of these: `SIGNUP_MODE=auto` defers to the
signup mode saved there (an explicit env value wins), and `LANDING_ENABLED` is
only the default until a landing value is saved.

## Roadmap

Phase 1: foundation — done. Phase 2: AWS one-click connect, Cloudflare,
domains — done. Phase 3: sending API, events, webhooks, tracking, SMTP relay —
done. Phase 4 (next): SDK, CLI, MCP, OpenAPI, docs, landing. Phase 5:
templates, preview, contacts, campaigns, audit UI.
Design: `docs/superpowers/specs/2026-08-24-sendsprite-design.md`.

## License

MIT
