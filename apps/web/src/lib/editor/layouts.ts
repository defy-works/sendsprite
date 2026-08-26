import type { CampaignBlock, CampaignTheme } from "@sendsprite/shared";

/**
 * Arrangements of blocks worth starting from.
 *
 * A blank canvas with six block types on it is a worse starting point than it
 * looks: the parts an email needs — a header that is not just an `<h1>`, a
 * feature row that survives Outlook, a footer with an address in it — are all
 * *combinations*, and working out that a footer is a divider, a small
 * paragraph and a spacer is not the author's job.
 *
 * These are values, not templates: inserting one appends exactly the blocks
 * below, which the author then edits like any others. Nothing here can produce
 * a block the palette could not, and every one of them parses as
 * `CampaignBlock[]` — the same check a save runs.
 *
 * The copy is placeholder text on purpose, and obviously so. A preset that
 * reads like finished writing is a preset that ships to a list unedited.
 */
export interface LayoutPreset {
  id: string;
  name: string;
  description: string;
  blocks: CampaignBlock[];
  /** Offered alongside the blocks; the author chooses whether to apply it. */
  theme?: CampaignTheme;
}

const lorem =
  "Say what happened, why it matters to the person reading, and what you would like them to do next.";

export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
  {
    id: "announcement",
    name: "Announcement",
    description: "A headline, a paragraph and one call to action.",
    blocks: [
      {
        kind: "heading",
        level: 1,
        text: "We shipped something",
        align: "center",
      },
      { kind: "text", html: lorem, align: "center" },
      {
        kind: "button",
        label: "Take a look",
        url: "https://example.com",
        align: "center",
      },
      { kind: "spacer", size: 16 },
    ],
  },
  {
    id: "hero",
    name: "Hero",
    description: "A full-width image over a headline and a button.",
    blocks: [
      {
        kind: "image",
        url: "https://example.com/hero.png",
        alt: "Describe this image",
        corners: "soft",
      },
      { kind: "spacer", size: 8 },
      { kind: "heading", level: 1, text: "Your headline" },
      { kind: "text", html: lorem },
      { kind: "button", label: "Read more", url: "https://example.com" },
    ],
  },
  {
    id: "two-up",
    name: "Two features",
    description: "A side-by-side row that stacks on a phone.",
    blocks: [
      { kind: "heading", level: 2, text: "Two things worth knowing" },
      {
        kind: "columns",
        layout: "1-1",
        columns: [
          [
            { kind: "heading", level: 3, text: "The first" },
            { kind: "text", html: "One sentence on what it is." },
          ],
          [
            { kind: "heading", level: 3, text: "The second" },
            { kind: "text", html: "One sentence on what it is." },
          ],
        ],
      },
    ],
  },
  {
    id: "media-text",
    name: "Image and text",
    description: "A narrow image beside a wider column of copy.",
    blocks: [
      {
        kind: "columns",
        layout: "1-2",
        columns: [
          [
            {
              kind: "image",
              url: "https://example.com/thumb.png",
              alt: "Describe this image",
              corners: "soft",
            },
          ],
          [
            { kind: "heading", level: 3, text: "A short heading" },
            { kind: "text", html: lorem },
          ],
        ],
      },
    ],
  },
  {
    id: "three-up",
    name: "Three features",
    description: "Three equal columns — a digest or a product row.",
    blocks: [
      {
        kind: "columns",
        layout: "1-1-1",
        columns: [1, 2, 3].map((n) => [
          { kind: "heading" as const, level: 3 as const, text: `Item ${n}` },
          { kind: "text" as const, html: "One line about it." },
        ]),
      },
    ],
  },
  {
    id: "footer",
    name: "Footer",
    description: "A rule, your address, and the line the law wants.",
    blocks: [
      { kind: "spacer", size: 24 },
      { kind: "divider" },
      {
        kind: "text",
        html: "Your Company · 1 Example Street · London · N1 1AA",
        align: "center",
      },
      {
        kind: "text",
        // Not the unsubscribe link — that is appended per recipient by the
        // fan-out and cannot be authored. This is the sentence beside it.
        html: "You are receiving this because you signed up at example.com.",
        align: "center",
      },
    ],
  },
];

export const presetById = (id: string): LayoutPreset | undefined =>
  LAYOUT_PRESETS.find((p) => p.id === id);
