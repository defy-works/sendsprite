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

`baseBranch` is `master`, the branch this repository actually uses; both
workflows trigger on `main` and `master`, so nothing breaks if the GitHub
default ends up being `main`. If the branch is ever renamed, change
`baseBranch` to match — `changeset status` and interactive `changeset add`
diff against it and fail when it does not exist.
