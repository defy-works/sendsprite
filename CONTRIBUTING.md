# Contributing to Sendsprite

Thanks for wanting to help. This page covers the CLA (read it before you start
writing code), the local setup, and what a mergeable pull request looks like.

## The CLA, and why there is one

Every contributor signs the [Contributor Licence Agreement](CLA.md) once. The
first pull request you open cannot be merged until you have — a bot comments
with a link and a one-line statement to post back, which takes about ten
seconds and covers all your later pull requests too.

You keep your copyright. What the CLA grants us is a licence broad enough to
sublicense, which is what lets us:

- **Sell commercial licences.** Sendsprite's server is AGPL-3.0-only. Some
  organisations cannot deploy AGPL software at all, so we want to offer them the
  same code under commercial terms. We can only do that if we hold the rights to
  every line, including yours.
- **Change the licence if we have to.** Licence bugs happen — an incompatible
  dependency, a court decision, a GPL revision. Without a CLA, fixing one means
  tracking down every past contributor for permission, and projects have been
  stuck for years that way.

The CLA is not an assignment. Your contribution stays yours: you can use it,
relicense it and republish it anywhere else, exactly as if you had never signed.

If you would rather not sign, say so in the issue. A good bug report, a failing
test case or a precise description of the fix is genuinely useful, and none of
those need a CLA.

## Licensing of what you write

Where your change lands decides its licence:

| Path                               | Licence         |
| ---------------------------------- | --------------- |
| `apps/web`, `infra/`, repo root    | `AGPL-3.0-only` |
| `packages/sdk` (`sendsprite`)      | `MIT`           |
| `packages/mcp` (`@sendsprite/mcp`) | `MIT`           |
| `packages/shared`                  | `MIT`           |

`packages/shared` is MIT because tsup inlines it into the published SDK and MCP
bundles — its code physically ships inside those MIT packages. So do not move
code from `apps/web` into `packages/shared`: that would relicense AGPL code as
MIT by accident. Move it the other way freely.

The name is handled separately — see [TRADEMARK.md](TRADEMARK.md).

## Before you build something big

Open an issue first. A short description of the problem and the shape of the fix
saves everyone the awkward conversation where a finished branch turns out to be
solving it the wrong way. Small fixes — a bug, a typo, a missing test — need no
issue; just send the pull request.

## Local setup

```bash
bun install
bun run --filter @sendsprite/web db:dev   # embedded Postgres 16, no Docker needed
cp .env.example apps/web/.env.local
bun run db:migrate
bun dev                                    # http://localhost:3000
```

## Before you open the pull request

Everything CI runs, in the order it runs it:

```bash
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run test:integration
bun run verify:pin
bun run test:e2e            # in apps/web; only if you touched the app or a spec
```

The e2e builds the app and runs against the built server, so nothing compiles
during a test. While iterating on a spec, `bun run test:e2e:dev` skips the build
and uses `next dev` instead — faster to start, and the only place a wait can
fail because a route was still compiling.

Also:

- **Add a test at the level the change lives at.** A pure function gets a unit
  test; anything touching the database or an API route gets an integration test;
  a user-visible flow gets a Playwright spec.
- **Record a changeset** if you changed `packages/sdk` or `packages/mcp`:
  `bun run changeset`, then commit the generated `.changeset/*.md`.
- **Write the commit message in the imperative**, prefixed with the kind of
  change and its area, matching the existing history:
  `fix(smtp): a relay that cannot bind no longer takes the instance down`.
  Keep each commit to one idea.

## Review

We read every pull request. Expect questions about edge cases and about the
comments — this codebase explains _why_ in prose, not just _what_, and a change
that silently drops that context will get pushed back. That is not a hazing
ritual; it is the thing that keeps the project readable.

## Security

Do not open a public issue for a vulnerability. Email <security@defy.works> and
we will come back to you.

## Questions

Open a discussion or an issue, or email <hello@defy.works>.
