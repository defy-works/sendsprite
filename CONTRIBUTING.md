# Contributing to Sendsprite

Thanks for wanting to help. This page covers the licensing of what you send,
the local setup, and what a mergeable pull request looks like.

## Licensing of what you write

There is no CLA. Everything in the repository is MIT (`LICENSE.md`), and by
opening a pull request you agree that your contribution is licensed under the
same terms — inbound is outbound, nothing more. You keep your copyright.
`packages/sdk`, `packages/mcp` and `packages/shared` carry their own copy of
the same licence because it ships inside the published npm tarballs.

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

**Run the e2e against an empty database before trusting a green run.** It uses
`DATABASE_URL` from `.env.local`, which on a machine you have been developing
on is not a fresh instance — and several specs branch on that. `setup.spec.ts`
runs the whole wizard only when it finds one, and takes a much shorter path
when it does not, so a change to onboarding can pass twenty-four out of
twenty-four locally and fail every spec in CI, which always starts empty. This
has happened.

```bash
# from apps/web, with your usual Postgres running
createdb sendsprite_e2e            # once
DATABASE_URL=postgres://…/sendsprite_e2e bun run db:migrate
DATABASE_URL=postgres://…/sendsprite_e2e bun run test:e2e
```

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
