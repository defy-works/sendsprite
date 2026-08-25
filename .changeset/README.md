# Changesets

This folder holds the pending release notes for the two published packages,
[`sendsprite`](../packages/sdk) and [`@sendsprite/mcp`](../packages/mcp).
`@sendsprite/web` and `@sendsprite/shared` are in `ignore` — the app is not
published, and `@sendsprite/shared` is private and inlined into both bundles by
tsup, so it never gets a version of its own.

Add one changeset per user-visible change:

```bash
bun run changeset          # pick packages, pick bump, write the summary
```

That writes a markdown file here; commit it with the change. On push to the
default branch `.github/workflows/release.yml` opens (or updates) a "Version
Packages" PR that consumes every pending changeset, bumps versions and rewrites
the changelogs. Merging that PR publishes to npm.

See <https://github.com/changesets/changesets> for the full format.

`baseBranch` is `main`, matching the branch CI builds. `bun run changeset` on a
checkout without a local `main` falls back to `bun run changeset -- --empty` (or
fetch `main` first) — `changeset status` diffs against that branch.
