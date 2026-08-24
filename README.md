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

| Variable                                             | Default  | Notes                                                                    |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `APP_URL`                                            | —        | Public URL, with protocol                                                |
| `APP_SECRET`                                         | —        | ≥ 32 chars; encrypts stored credentials                                  |
| `DATABASE_URL`                                       | —        | Postgres connection string                                               |
| `POSTGRES_PASSWORD`                                  | —        | Compose only; alphanumeric recommended (interpolated unencoded into URL) |
| `SIGNUP_MODE`                                        | `auto`   | `auto` → open until first user, then invite; or `open`/`invite`/`closed` |
| `EMAIL_PASSWORD_ENABLED`                             | `false`  | Email + password sign-in                                                 |
| `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` | —        | OAuth providers                                                          |
| `WORKER_MODE`                                        | `inline` | `inline` / `separate` / `none`                                           |
| `SMTP_ENABLED`                                       | `true`   | SMTP relay on 587 (Phase 3)                                              |
| `LANDING_ENABLED`                                    | `true`   | `false` sends `/` to `/app`                                              |
| `EMAIL_RETENTION_DAYS`                               | `90`     | Body/attachment purge window                                             |

## Roadmap

Phase 1 (this): foundation. Phase 2: AWS one-click connect, Cloudflare, domains.
Phase 3: sending API, events, webhooks, SMTP. Phase 4: SDK, CLI, MCP, docs,
landing. Phase 5: templates, preview, contacts, campaigns, audit UI.
Design: `docs/superpowers/specs/2026-08-24-sendsprite-design.md`.

## License

MIT
