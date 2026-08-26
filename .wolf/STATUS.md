# STATUS — sendsprite-monorepo

> Single source of truth for resuming work. Read this FIRST when starting a session.
> Update this file at the end of every work phase so the next `/clear` resumes in 1 read.
> Last updated: 2026-08-27

---

## ✅ Done

<!-- Move items here from "🚀 Next phase" when finished. Group by area. -->

### UI/UX overhaul (2026-08-27) — from a list of reported issues

Five commits on `master`. Every item the user listed, plus what looking for
them turned up.

**Design system.** `components/ui/icons.tsx` (in-house line-art on a 24 grid,
sized from `font-size`), `Modal` (portalled — a dialog inside a `.glass` card
inherits its `backdrop-filter`, which makes `position:fixed`
containing-block-relative), `ConfirmProvider`, `ToastProvider`, `Menu`,
`Select` (a real ARIA listbox), `Switch`/`Checkbox`, `Tabs`, `Field`,
`PageHeader`, `SegmentedControl`, `ColorField`, `FileDrop`, `EmailPreview`.
Every `window.confirm`/`alert`/`prompt` is gone — sixteen call sites.
`Button.ghost` (text on glass, invisible on a card) is now toolbar-only;
card actions use `subtle`, destructive page actions `dangerSubtle`.

**Navigation.** Setup has a way out on every step (`Exit setup`), and a
standing banner names what is still missing. Sending settings merged into
`/app/settings` with a sticky section rail. The Cloudflare "not configured"
card no longer shows customers instructions for a box they have no shell on.
Admin moved out of the team sidebar to its own `/admin` area.

**Features.** Team deletion (`services/team-delete.ts` — the row cascades, but
the SES identities, config set, SNS topic and DNS records live in someone
else's account and are torn down first). An account page (name, password,
sessions). Team suspension, per-org daily/monthly/retention overrides, and an
instance-admin grant, all at `/admin` (migration 0024). Test sends for
campaigns and templates (`services/test-send.ts`).

**Editor.** Columns (four ratio presets, fixed pixel widths, `@media` stacking
under 620px), per-block alignment and colour, an image width, button corners.
Palette with click-and-drag, a canvas with drop zones inside every column, a
style inspector. `lib/editor/tree.ts` holds the structure as pure functions
(`tests/unit/campaign-tree.test.ts`). Templates use the **same** designer
(migration 0025 adds `templates.design`), with an HTML mode still one click
away and the REST contract unchanged.

**Fixes.** bug-005 (one-click "always expires"), bug-006 (dark preview
backdrop), bug-007 (palette a11y), bug-008 (design compile order).

**Verified:** typecheck clean, lint at baseline, 921 unit tests, integration
green except the known `webhooks.test.ts` retry-schedule failure, **20/20
e2e**.

### Editor round two (2026-08-27) — the four items the pass above deferred

Migration 0026 (`team_assets`, `team_layouts`, `campaigns.theme`,
`templates.theme`).

- **Image upload.** `POST /api/assets` → bytes in Postgres → served
  unauthenticated from `/a/<token>` with a year of cache headers, because a
  mail client has no cookie. Type sniffed from the file header, **SVG
  refused**, `nosniff` + `sandbox` CSP on the way out, 24 random bytes in the
  URL rather than the ULID. Deduped by sha256 per team.
- **`DateTimePicker`.** The last browser-drawn control. A `role="grid"`
  calendar with one tab stop and the full key set, keeping a real
  `<input type="time">` — the date _popup_ was the only part worth replacing.
- **Layouts.** Six presets as values plus per-team saved ones
  (`services/layouts.ts`). Blocks are contract-validated on write, because a
  layout is inserted without further checking.
- **Body theme.** Page/card colour, width, font stack, text and link colour,
  card corners — in the contract, the renderer, both editors, the fan-out and
  the test send. An absent theme renders byte-identically to before, which is
  asserted and is what made it safe with no backfill.

**Verified:** typecheck and lint clean, 305 shared + 435 web unit, 582
integration (the one known `webhooks.test.ts` failure), **24/24 e2e**, build
clean.

### Org-level AWS + Cloudflare, instance admin (2026-08-26) — phases 8 & 9

Branch `feat/org-level-connections`, 25 commits. **Every team now connects its
own AWS account; the deployment holds no cloud credentials at all.**

**Phase 8 — instance admin + per-team retention**

- `INSTANCE_ADMIN_EMAILS` env var **or** `user.instanceAdmin`; the flag is
  declared through better-auth `additionalFields` because `schema/auth.ts` is
  generated. First signup is flagged when the env list is empty.
- `requireInstanceAdmin()` gates the new `/app/admin` (signup mode, landing
  page, retention **ceiling**).
- Retention is per team under that ceiling; the nightly purge iterates teams,
  isolating failures.

**Phase 9 — org-level connections**

- `team_aws` / `team_cloudflare` / `team_send_rate`; row existence _is_ the
  connection, so `aws_mode` (and `instance_role`) are gone and the key columns
  are `notNull`.
- `requireOwner` → `requireTeamAdmin` (owner **or** admin, active team).
- **Security:** `ingestSesEvent` had no team predicate. Verified against the
  pre-fix code that one tenant could name another's email id and flip it to
  `bounced`. Now scoped, and the webhook moved to
  `/api/webhooks/ses/[teamId]`, authorised on path **and** topic ARN.
- AWS resource names carry a sanitised org slug (stack, config set, topic) —
  two orgs may share one AWS account, and a shared config set would repoint
  one org's SES events at the other's topic. Names are persisted, never
  re-derived.
- Per-team send-rate bucket and account quota; dropped the `usageSnapshot`
  shortcut that reported `accountUsed: 0`.
- Migrations 0019–0023. 0022 (data move) is hand-written and was inserted into
  `_journal.json` by hand; the snapshot chain was relinked.

**Verified:** typecheck clean, lint at the 126-error pre-existing baseline,
884 unit tests, 549/550 integration, 19/19 e2e.

**Known pre-existing failure (not from this work, reproduced at 052dc06):**
`webhooks.test.ts` "retries on failure with the 1m/5m/30m/2h/8h schedule" —
logged in buglog.json.

### Cloudflare integration — OAuth + credential-free fallback (2026-08-26)

Replaced the pasted-API-token integration with Cloudflare OAuth, and gave
instances without an OAuth client a zero-credential path.

- `lib/cloudflare/oauth.ts` — Authorization Code + PKCE (S256) against
  `dash.cloudflare.com/oauth2/{auth,token,revoke}`, verified live from
  Cloudflare's `.well-known/openid-configuration`. Refresh + best-effort revoke.
- `lib/cloudflare/scopes.ts` — `CF_DEFAULT_SCOPES`, dependency-free so
  `env.schema.ts` can default from it.
- `services/cloudflare-connect.ts` — `beginOauth` / `completeOauth` /
  `disconnectCloudflare` / `cloudflareClient` (auto-refresh; a rejected
  refresh self-disconnects so the UI never shows a dead grant).
- Routes `api/setup/cloudflare/{start,callback}` — state + PKCE verifier parked
  in an encrypted httpOnly `SameSite=Lax` cookie, read once.
- `lib/dns/cloudflare-zone.ts` — walks up labels doing NS lookups to find the
  delegation point; deep-links `?to=/:account/<zone>/dns/records` only when the
  nameservers are `*.ns.cloudflare.com`. Stored on `domains.cloudflare_zone`
  during provisioning (manual mode only).
- Migrations `0017_cloudflare_oauth.sql` (add token columns + `cloudflare_zone`),
  `0018_drop_cloudflare_api_token.sql` (drop `cloudflare_token_enc`).
- `CloudflareStep` has three states: connected / Connect button / "not
  configured" with the client-registration steps.

**Unchanged on purpose:** `dnsMode` (`auto`|`manual`), `cloudflareZoneId`,
`ExpectedRecord.cloudflareId`, delete-time record cleanup and the whole REST +
SDK surface. OAuth swaps the credential, not the capability.

---

## 🚀 Next phase

**Goal:** Push, then register the real Cloudflare OAuth client.

### Not pushed

`origin/master` is still at `052dc06`; local `master` is many commits ahead
(the org-level-connections merge plus this UI pass). The
`feat/org-level-connections` branch still exists and can be deleted.

### Carried over

- Register the hosted Cloudflare OAuth client; confirm scope strings via
  `GET /client/v4/oauth/scopes` (authenticated) and update `CF_DEFAULT_SCOPES`
  if they differ from `zone.read dns.write offline_access`.
- Redirect URI must be exactly `https://<hosted APP_URL>/api/setup/cloudflare/callback`.
- **Open:** public vs private client visibility. Public is needed for users
  outside our account, requires DNS TXT domain verification, and is
  **permanent** — decide before flipping it.
- **Open:** BIND zone-file download to cut the manual DNS path from six
  copy-pastes to one upload.

### Worth doing soon

- Diagnose the pre-existing `webhooks.test.ts` retry-schedule failure. It is
  the one integration failure and it predates all of this.
- `jobs/handlers/billing-meter.ts` reads env at **module scope**, which makes
  any test that starts the worker depend on APP_URL being set by someone else.
  Move it inside the handler.
- **Asset growth has no ceiling and no reporting.** Images are 2 MB each,
  deduped per team, and nothing purges them — correctly, since delivered mail
  keeps fetching them. Worth a per-team total on `/admin/organizations/[id]`
  before it is a surprise, and an operator-side cap if this is ever hosted.
- **Layouts and the theme are dashboard-only.** Neither is in the REST
  contract; `theme` is (on campaigns), layouts are not, and that asymmetry is
  deliberate but undocumented in the OpenAPI description.
- The editor now covers a body and a brand. What it still cannot do: a
  reusable _header_ that updates everywhere (a layout is copied in, not
  linked), and per-recipient content beyond the unsubscribe footer.

---

## 📁 Active architecture

- **Stack:** Next 16 (app router, server actions), React 19, Tailwind v4,
  drizzle + Postgres, pg-boss, better-auth (+ organization plugin), Tiptap,
  dnd-kit, Polar. Bun workspaces: `apps/web`, `packages/{shared,sdk,mcp}`.
- **Key tables:** `organization` (the team; everything cascades from it),
  `team_settings` (limits, retention, `setup_completed`, `suspended_at`),
  `team_aws` / `team_cloudflare` (row existence _is_ the connection),
  `domains`, `emails` + `email_events`, `templates` (+ `template_versions`,
  `design`), `campaigns`, `contact_books` / `contacts`, `suppressions`,
  `webhooks` + `webhook_deliveries`, `instance_settings` (singleton),
  `team_billing` / `billing_usage`, `audit_log` (no FK, outlives its team).
- **Patterns:**
  - Services hold the rules and never import `next/*`; server actions resolve
    the actor, delegate, revalidate. `requireTeam` / `requireTeamAdmin` /
    `requireInstanceAdmin` gate in the route, and **every server action
    re-checks** — an action is a POST endpoint, not a button.
  - One renderer. `renderBlocks` and `renderTemplate` live in
    `@sendsprite/shared`, are pure, and are called by both the preview and the
    send; there is deliberately no React renderer for blocks anywhere.
  - Contracts are the boundary: `packages/shared/src/api/*` is parsed at the
    API edge _and_ re-parsed by the renderer, because a body read from `jsonb`
    is a claim, not a guarantee.
  - UI: `components/ui/*` is the design system, `components/editor/*` the
    visual email editor (shared by campaigns and templates),
    `components/app/*` the shell. **No browser-drawn control anywhere** — no
    native `select`, `confirm`, `alert`, `prompt`, file input or
    `datetime-local`. (`<input type="time">` inside `DateTimePicker` is the
    one deliberate keep; it is a segmented text field, not a popup.)
  - Uploaded images are `bytea` in `team_assets`, served from `/a/<token>`
    with no auth — see the self-hosting docs for why that trade was made.

---

## ⚠️ External blockers (don't block coding)

- _<env vars, secrets, external accounts, manual steps>_

---

## 🔧 Useful commands

```bash
# from apps/web unless noted
./node_modules/.bin/tsc --noEmit -p tsconfig.json   # NOT `npx tsc` (decoy pkg)
bun run test                                        # unit (all workspaces, from root)
bunx vitest run --project integration               # needs embedded postgres
bunx playwright test                                # builds the app first (~1m)
bunx playwright test --project=app tests/e2e/x.spec.ts
bun run db:generate && mv drizzle/00NN_*.sql drizzle/00NN_name.sql  # then fix _journal.json tag
./node_modules/.bin/eslint apps packages            # from the repo root
./node_modules/.bin/prettier --write "apps/web/src/**/*.{ts,tsx}"
```

---

## 📚 References (read IF needed)

- `.wolf/cerebrum.md` — User Preferences + Do-Not-Repeat + Decision Log
- `.wolf/anatomy.md` — token-efficient file index
- `.wolf/buglog.json` — known bugs + fixes
