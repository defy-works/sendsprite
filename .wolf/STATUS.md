# STATUS — sendsprite-monorepo

> Single source of truth for resuming work. Read this FIRST when starting a session.
> Update this file at the end of every work phase so the next `/clear` resumes in 1 read.
> Last updated: 2026-08-26

---

## ✅ Done

<!-- Move items here from "🚀 Next phase" when finished. Group by area. -->

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

**Goal:** Register the real Cloudflare OAuth client for the hosted service.

### Merged

24 commits fast-forwarded onto `master` (now at `26c729c`). **Not pushed** —
`origin/master` is still at `052dc06`. The `feat/org-level-connections` branch
still exists and can be deleted.

### Then, carried over

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

- Diagnose the pre-existing `webhooks.test.ts` retry-schedule failure.
- `jobs/handlers/billing-meter.ts` reads env at **module scope**, which makes
  any test that starts the worker depend on APP_URL being set by someone else.
  Move it inside the handler.

---

## 📁 Active architecture

- **Stack:** _<frameworks, libraries, runtime>_
- **Key tables / modules:** _<list>_
- **Patterns:** _<conventions enforced project-wide>_

---

## ⚠️ External blockers (don't block coding)

- _<env vars, secrets, external accounts, manual steps>_

---

## 🔧 Useful commands

```bash
# add the most-used commands here so the next session has them ready
```

---

## 📚 References (read IF needed)

- `.wolf/cerebrum.md` — User Preferences + Do-Not-Repeat + Decision Log
- `.wolf/anatomy.md` — token-efficient file index
- `.wolf/buglog.json` — known bugs + fixes
