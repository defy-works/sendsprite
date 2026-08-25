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

| Variable                                             | Default       | Notes                                                                      |
| ---------------------------------------------------- | ------------- | -------------------------------------------------------------------------- |
| `APP_URL`                                            | —             | Public URL, with protocol                                                  |
| `APP_SECRET`                                         | —             | ≥ 32 chars; encrypts stored credentials                                    |
| `DATABASE_URL`                                       | —             | Postgres connection string                                                 |
| `POSTGRES_PASSWORD`                                  | —             | Compose only; alphanumeric recommended (interpolated unencoded into URL)   |
| `SIGNUP_MODE`                                        | `auto`        | `auto` → open until first user, then invite; or `open`/`invite`/`closed`   |
| `EMAIL_PASSWORD_ENABLED`                             | `false`       | Email + password sign-in                                                   |
| `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` | —             | OAuth providers                                                            |
| `WORKER_MODE`                                        | `inline`      | `inline` / `separate` / `none`                                             |
| `SMTP_ENABLED`                                       | `true`        | SMTP relay on 587 (Phase 3)                                                |
| `LANDING_ENABLED`                                    | `true`        | `false` sends `/` to `/app`                                                |
| `EMAIL_RETENTION_DAYS`                               | `90`          | Body/attachment purge window                                               |
| `AWS_DEFAULT_REGION`                                 | `us-east-1`   | Region preselected in the AWS connect wizard                               |
| `CFN_TEMPLATE_URL`                                   | Sendsprite S3 | S3 URL of the one-click CloudFormation template (must be S3)               |
| `AWS_E2E_MOCK`                                       | —             | `1` swaps AWS clients for an in-memory fake; ignored in production (tests) |

Settings → Instance can override two of these: `SIGNUP_MODE=auto` defers to the
signup mode saved there (an explicit env value wins), and `LANDING_ENABLED` is
only the default until a landing value is saved.

## Roadmap

Phase 1: foundation — done. Phase 2: AWS one-click connect, Cloudflare,
domains — done. Phase 3 (next): sending API, events, webhooks, SMTP. Phase 4: SDK, CLI, MCP, docs,
landing. Phase 5: templates, preview, contacts, campaigns, audit UI.
Design: `docs/superpowers/specs/2026-08-24-sendsprite-design.md`.

## License

MIT
