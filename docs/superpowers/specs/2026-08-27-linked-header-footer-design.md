# Linked header and footer layouts

**Date:** 2026-08-27
**Status:** approved (shape decided), implementing

## Problem

A layout is a saved block fragment. Today the editor **copies** it into a
campaign body (`LayoutPicker`), so editing the layout later changes nothing
that already used it. Authors want a header (and footer) they set once and
have update everywhere.

## Decision (from the approved fork)

A campaign gets an optional **header** slot and **footer** slot, each a
reference to a `team_layouts` row. They render above and below the body, and
resolve to the layout's **current** blocks at send time — so editing the
layout updates every campaign not yet sent; sent mail is frozen (its HTML was
rendered once and stored). Body blocks stay copy-in as they are.

## What "resolve at send" means precisely

The stored `campaigns.html`/`text` is produced **once, when sending starts**
(`startCampaign`, and the `ensureRendered` fallback). That is the single
moment the header/footer layouts are read. Consequences, all intended:

- Edit a linked layout → every campaign still in `draft`/`scheduled` picks it
  up at its send. A campaign already `sending`/`sent` keeps the render it
  froze.
- Delete a linked layout → the reference resolves to nothing and that slot is
  simply empty. No dangling error (the id is tolerated, like `bookId`).

## Theme

The whole email — header, body, footer — renders in the **campaign's** theme.
A layout's own `theme` is used only when the layout is edited standalone; a
linked header takes the campaign's colours so the message is visually one
piece. Documented; not configurable.

## Data model

`campaigns.header_layout_id` and `footer_layout_id` (migration 0032), nullable
`text`, no foreign key — the same choice `book_id`/`domain_id` make, so a
campaign outlives a deleted layout and the resolve tolerates a missing id.

## Contract

`headerLayoutId` / `footerLayoutId` join the campaign contract as optional
nullable id strings (create, update, the returned object, the SDK types) —
consistent with `theme` being authored campaign data. This does **not** ship a
layouts API: there is still no `/layouts` collection, and an API-only client
leaves the fields null and composes headers into `blocks` directly. The
OpenAPI description says so, replacing the note that layouts are purely
copy-in.

`checkRefs` validates that a referenced layout belongs to the actor's team,
exactly as it does for `bookId` and `domainId`.

## Rendering

A pure `withHeaderFooter(body, header, footer)` in shared returns
`[...header, ...body, ...footer]`. `startCampaign`, `ensureRendered` and the
editor preview all render that composed list through the **same**
`renderBlocks`, so the preview cannot disagree with the send. The unsubscribe
footer is still appended last by `renderBlocks`, after the footer layout.

## Editor

Two selects in the campaign settings — Header and Footer — listing the team's
layouts plus "None". The page passes the team's layouts (id, name, blocks) so
the live preview composes the real header and footer, in the campaign theme.
Setting a slot links; it does not copy, so the existing "insert a layout"
(copy-in) action stays for one-off use.

## Testing

- **integration** — a campaign with a header and footer layout renders
  header-then-body-then-footer-then-unsubscribe at send; a missing layout id is
  tolerated (empty slot); `checkRefs` rejects a layout id from another team;
  editing the layout before send changes the render, after send does not.
- **crud** — `publicCampaign` carries the two ids.
- **shared** — `withHeaderFooter` order.
