---
"sendsprite": minor
---

Campaign bodies gain columns, per-block presentation and a body theme.

Purely additive — every field is optional, and a body written against the
previous types still sends the same email:

- `HeadingBlock`, `TextBlock`: `align`, `color`.
- `ButtonBlock`: `align`, `color`, `textColor`, `corners`, `fullWidth`.
- `ImageBlock`: `align`, `width` (25/50/75/100), `corners`.
- `DividerBlock`: `color`.
- New `ColumnsBlock` — a row of two or three columns from four ratio presets
  (`1-1`, `1-1-1`, `2-1`, `1-2`), holding up to 20 blocks each. It cannot
  nest: the Word engine behind Outlook on Windows measures an inner table
  against the wrong containing block, so `CampaignBlock` is now
  `LeafBlock | ColumnsBlock` and a column takes leaves only.
- New `CampaignTheme` on create, update and the returned campaign — page and
  card colour, content width, font family, text and link colour, card
  corners. Absent (or `null` on a returned campaign) means the renderer's
  defaults, which is byte-for-byte what a campaign rendered before themes
  existed.
