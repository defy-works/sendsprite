# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-08-26

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

- **Brand/visual work — six rejected passes before it landed.** In order:
  filled pixel envelope ("too generic"); bare down chevron ("too abstract,
  doesn't look like the flap"); solid bevelled flap ("looks 3D"); flat shallow
  wedge ("terrible"); closed line-art envelope with a straight top ("looks like
  a box"); envelope-in-flight with motion streaks, from the user's own sketch
  ("don't like this concept... envelope looks incomplete").
  **Accepted: a complete 1px line-art envelope, symmetric flap forming the top
  edge, diagonal indigo gradient.** Rules:
  - **Line, not fill.** Single-pixel outline, black showing through.
  - **Gradients yes, bevels no.** A ramp travelling across the whole mark is
    wanted; per-edge light/shade faking a raised surface is not.
  - **Never a closed rectangle with a V inside it** — the rectangle wins the
    gestalt. The flap must BE the top edge.
  - **Keep the mark closed.** An open side reads as incomplete, not as motion.
  - **Symmetric flap.** The asymmetric version from their sketch reads as a
    chart line inside a box once it is on a hard pixel grid.
  - **Crease four rows down on a ten-row box (~44%).** Deeper was called
    "too deep"; shallower reads as a basket.
  - **Two-pixel stroke, on an 18 x 13 body.** A one-pixel line was too thin
    and lands on less than a device pixel at favicon size.
  - **Don't "match" the wordmark's weight by scaling the bitmap.** Scaling 2x
    doubles the size along with the stroke and the type swamps the mark.
    Relative to their own heights the mark's 2/15 and the wordmark's 1/9 are
    already the same weight; leave them.
  - Don't offer half-broken sparse/dashed treatments — they read as crop marks
    and collapse at small sizes.

- **"Don't do things the lazy way — do the things the right way."** Said while
  approving the org-level connections design (2026-08-26). Concretely, for this
  project that means: no compatibility shims left behind after a refactor, no
  single-valued enums or dead columns kept "just in case", no renaming a test
  fixture in fourteen files when a helper is the honest fix, and fix the
  security hole the refactor exposes rather than routing around it. Prefer the
  migration that drops the old thing over the one that leaves it orphaned.

- **Answers design questions decisively and will overrule a recommendation.**
  On the org-level work they took the recommended option three times and
  overruled it twice (retention per-team-with-ceiling over instance-only;
  owner-or-admin over owner-only), then added a requirement unprompted (env
  var _as well as_ the admin column). Present real alternatives with honest
  trade-offs — they read them.

- **Never `git checkout <sha> -- <paths>` with uncommitted work in the tree.**
  Used it to check whether a failing test was pre-existing; restoring with
  `git checkout HEAD -- <paths>` then wiped every uncommitted edit to
  already-tracked files while leaving new files behind, so the loss was
  partial and nearly invisible. Read an old version with
  `git show <sha>:<path>` instead, or commit/stash first.
- **Two integration tests are flaky under parallel load** (they pass in
  isolation): `email-send.test.ts` "two concurrent attempts ... not_claimed"
  and, separately, `webhooks.test.ts` "retries on failure with the
  1m/5m/30m/2h/8h schedule" fails consistently even at older commits — that
  one is a genuine pre-existing failure, logged as a bug, not a regression.
  Check a suspected regression against the base commit before chasing it.

- **`npx tsc` in this repo resolves to a decoy package** that prints "This is
  not the tsc command you are looking for" to stdout and exits 0. Piping it
  through `grep` for errors therefore looks clean while checking nothing. Use
  `./node_modules/.bin/tsc --noEmit -p tsconfig.json` from `apps/web`, or
  `bun run typecheck`.
- **`src/db/schema/auth.ts` is generated** by `bun run auth:generate`. To add a
  column to `user`, declare it in `betterAuth({ user: { additionalFields } })`
  and re-run the generator — a hand-added column is wiped on the next run.
  Additional fields also ride on `session.user`, so a gate needs no extra query.
- **drizzle-kit numbers migrations from its own `_journal.json`,** not from the
  files on disk. A hand-written migration must be added to the journal or the
  next `db:generate` will reuse its number. Inserting one by hand also means
  relinking the snapshot chain (`id` / `prevId`).
- **drizzle-kit's TTY prompt also fires at table level:** one table dropped and
  another created in the same diff reads as a possible rename. Keep the create
  additive (leave the old table in the schema, marked deprecated) and drop it
  in a later, separate migration.
- **`INSERT … ON CONFLICT DO UPDATE` cannot express a partial patch** on a table
  with NOT NULL columns: Postgres constraint-checks the candidate row before it
  looks for a conflict. `team-aws.ts` and `cloudflare-connect.ts` branch on an
  existence check instead.
- **The e2e fake AWS client must vary per team.** `fake-client.ts` returned a
  constant SNS topic ARN; once `team_aws.sns_topic_arn` became unique that
  capped the whole suite at one connected team. It derives the ARN from the
  requested name now, as SNS does.

## Key Learnings

- **Brand assets are generated, not hand-authored.** `scripts/gen-brand.mjs` rasterises
  every mark on an integer grid and emits both `apps/web/public/brand/*.svg` and
  `apps/web/src/components/ui/Logo.tsx`. Edit the generator and re-run `node
scripts/gen-brand.mjs`; never hand-edit Logo.tsx or the SVGs. `apps/web/public/favicon.svg`
  is a copy of `brand/favicon.svg`.
- **Accent palette lives in `apps/web/src/styles/globals.css` `@theme`** — ink `#000`/`#0a0a0a`
  plus a full indigo scale. The brand ramp uses indigo-400/500/600 so it survives on both
  the black app surface and a white background.
- **Root `bun run lint` reports ~126 pre-existing errors** in the untracked `.wolf/` and
  `.opencode/` tooling dirs (`no-undef` on `process`, `no-empty`). That is the baseline;
  only regressions in `apps/`, `packages/`, `scripts/` matter.
- **`scripts/*.mjs` get no Node globals from eslint** (the config has no `languageOptions.globals`
  block and `no-undef` is live for non-TS files). Use `import.meta.dirname` instead of
  `process.argv` / `new URL(...)`, and avoid `console`.

- **Project:** sendsprite-monorepo
- **Description:** Self-hosted email API and marketing platform on Amazon SES. A Resend / useSend

- **Two orgs can share one AWS account — never assume tenant isolation comes
  from the tenant's cloud account.** Fixed AWS resource names (`CONFIG_SET =
"sendsprite"`, `TOPIC_NAME = "sendsprite-events"`) are safe only while there
  is one org. With org-level connections they must carry a sanitised org slug,
  because `CreateConfigurationSetEventDestination` silently _updates_ on
  AlreadyExists and would repoint one org's SES events at another's SNS topic.
- **`infra/aws/sendsprite-connect.yaml` names the IAM user
  `!Sub "sendsprite-${AWS::StackName}"`** and scopes its SNS policy to
  `sendsprite-*`, so slugging the CloudFormation stack name makes the IAM user
  unique with no template change. The template only mints an IAM user and
  POSTs the keys back — the SNS topic, configuration set and subscription are
  all created by our own code in `services/aws-connect.ts`.
- **AWS resource names must be persisted, never re-derived.**
  `organization.slug` is mutable; `team_aws.configSet` / `snsTopicArn` hold the
  names actually created, and every later read uses the stored value.

### Cloudflare integration

- **Cloudflare has first-party OAuth since 2026-06-03** ("self-managed OAuth
  clients", Manage Account → OAuth clients). Endpoints live at
  `dash.cloudflare.com/oauth2/{auth,token,revoke}`; verify against
  `https://dash.cloudflare.com/.well-known/openid-configuration`, which is
  public and fetchable. Authorization Code only, PKCE S256, `refresh_token`.
- **OAuth scope names = API token permission names**, lowercased with
  `.read`/`.write` (Cloudflare's example: `workers-platform.read`). They are
  NOT published as a static list — `GET /client/v4/oauth/scopes` (authenticated)
  is the only way to confirm them. Hence `CLOUDFLARE_OAUTH_SCOPES` is an env
  override rather than a hardcoded constant.
- **Redirect URIs match exactly, no wildcards.** This is the whole reason a
  self-hosted product cannot ship one shared OAuth client: each instance must
  register its own (private visibility suffices). Public visibility needs DNS
  TXT domain verification and is **permanent**.
- **The dashboard deep link is `?to=/:account/<zone>/dns/records`** — `:account`
  is a literal placeholder Cloudflare resolves for the signed-in user, so no
  account id is needed and no credentials are involved. There is **no** way to
  prefill the add-record form; the only bulk path is DNS → Import and Export,
  which takes a BIND file.
- `drizzle-kit generate` **prompts (needs a TTY) when a table has both dropped
  and added columns** in one diff — it asks "renamed or created?". Split into
  two runs (additive first, then the drop) to keep it non-interactive.
- `tests/integration/webhooks.test.ts > retries on failure with the
1m/5m/30m/2h/8h schedule` **fails on a clean checkout** (`deliver` resolves
  null). Pre-existing, unrelated to any Cloudflare work — verified by stashing.
- `bunx vitest run` with no `--project` fails outright ("Projects integration
  and unit have different maxWorkers but same sequence.groupOrder"). Use
  `bun run test` / `bun run test:integration`.

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->

- **[2026-08-26] Cloudflare: OAuth, gated on env config, with a
  credential-free deep-link default.** The user first asked to replace token
  auth with "a simple URL with params" shown only when the site is on
  Cloudflare, then asked whether OAuth was possible, then settled on: hosted
  gets the polished path, self-hosted _can_ set the same path up but defaults
  to the deep link.
  - Chosen over a pasted API token: nothing long-lived for the user to mint,
    scope, or leak; revocable from their Cloudflare profile.
  - Chosen over hosted-only OAuth behind a feature flag: one code path,
    lit up by `CLOUDFLARE_OAUTH_CLIENT_ID`/`_SECRET` being present. Self-hosters
    register their own client (redirect URIs are exact-match, so they must).
  - Rejected: a callback relay on sendsprite.com so self-hosters could share
    our client — it makes every self-hosted install depend on our servers to
    finish setup, and our servers would see the auth code.
  - **This reversed an earlier in-session decision to "fully purge" `dnsMode`,
    `cloudflareZoneId` and `ExpectedRecord.cloudflareId`.** Automatic DNS
    writing survives, so all of that had to stay; OAuth swaps the credential,
    not the capability. The REST/SDK surface is unchanged.
