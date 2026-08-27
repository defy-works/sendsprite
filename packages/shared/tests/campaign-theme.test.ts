import { describe, expect, it } from "vitest";
import { renderBlocks } from "../src/campaign-render";
import {
  CampaignTheme,
  CONTENT_WIDTHS,
  type CampaignBlock,
} from "../src/api/campaigns";

const BODY: CampaignBlock[] = [
  { kind: "heading", level: 1, text: "Title" },
  { kind: "text", html: 'Read the <a href="https://x.test">blog</a>' },
  {
    kind: "columns",
    layout: "1-1",
    columns: [
      [{ kind: "image", url: "https://cdn.test/a.png", alt: "A" }],
      [{ kind: "text", html: "Right" }],
    ],
  },
];

/** Content cell widths, in order. */
const colWidths = (html: string) =>
  [...html.matchAll(/class="ss-col" width="(\d+)"/g)].map((m) => Number(m[1]));

/**
 * Cells plus gutters. Matched on the class, not on every `width=` in the
 * document: an image inside a column carries one too, and summing those as
 * well is how this assertion silently stops measuring the row.
 */
const rowWidth = (html: string) =>
  [...html.matchAll(/class="ss-(?:col|gutter)" width="(\d+)"/g)]
    .map((m) => Number(m[1]))
    .reduce((a, b) => a + b, 0);

describe("the body theme", () => {
  /**
   * The property that makes this safe to add to a live table: no data
   * migration, no backfill, and nothing to check on the way out. Every
   * campaign already stored renders the bytes it always did.
   */
  it("changes nothing when it is absent", () => {
    expect(renderBlocks(BODY, { theme: {} })).toEqual(renderBlocks(BODY));
    expect(renderBlocks(BODY, { theme: undefined })).toEqual(
      renderBlocks(BODY),
    );
  });

  it("paints the page, the card and the text", () => {
    const { html } = renderBlocks(BODY, {
      theme: {
        pageBackground: "#0b1020",
        cardBackground: "#fef3c7",
        textColor: "#1f2937",
      },
    });
    // `height:100%` so a document shorter than the frame still paints the
    // root's background all the way down.
    expect(html).toContain(
      'style="height:100%;background:#0b1020;color-scheme:light"',
    );
    expect(html).toContain("background:#fef3c7");
    expect(html).toContain("color:#1f2937");
    // The default is gone, not merely overridden somewhere later.
    expect(html).not.toContain("#f3f4f6");
  });

  it("keeps a block's own colour ahead of the theme's", () => {
    const { html } = renderBlocks(
      [{ kind: "heading", level: 2, text: "H", color: "#dc2626" }],
      { theme: { textColor: "#1f2937" } },
    );
    expect(html).toContain("color:#dc2626");
  });

  it.each(CONTENT_WIDTHS)("lays a %spx card out end to end", (width) => {
    const { html } = renderBlocks(BODY, { theme: { contentWidth: width } });
    expect(html).toContain(`class="ss-card" width="${width}"`);
    // The columns follow the card: cells plus gutters fill the content width
    // exactly, or Outlook wraps the last column. This is the assertion that
    // would catch a card width changed without the column maths.
    expect(rowWidth(html)).toBe(width - 48);
  });

  it("moves the stacking breakpoint with the card", () => {
    for (const width of CONTENT_WIDTHS) {
      const { html } = renderBlocks(BODY, { theme: { contentWidth: width } });
      expect(html).toContain(`max-width:${width + 20}px`);
    }
  });

  it("halves a 480px card into two 208px columns", () => {
    const { html } = renderBlocks(BODY, { theme: { contentWidth: 480 } });
    // 480 - 48 padding - 16 gutter = 416, split evenly.
    expect(colWidths(html)).toEqual([208, 208]);
  });

  it("swaps the font stack for every text-bearing element", () => {
    const { html } = renderBlocks(
      [
        { kind: "heading", level: 1, text: "H" },
        { kind: "text", html: "T" },
        { kind: "button", label: "B", url: "https://x.test" },
      ],
      { theme: { font: "serif" } },
    );
    expect(html).toContain("Georgia");
    expect(html).not.toContain("BlinkMacSystemFont");
  });

  /**
   * Links are the one thing a theme cannot reach inline. `text.html` may not
   * carry a `style` attribute — that restriction is exactly what makes the
   * field safe to emit unescaped — so the colour has to arrive through the
   * stylesheet, and the test is that it does.
   */
  it("colours links through the stylesheet, not the markup", () => {
    const { html } = renderBlocks(BODY, {
      theme: { linkColor: "#059669" },
    });
    expect(html).toContain("a{color:#059669!important}");
    expect(html).toContain("x-apple-data-detectors");
    // The anchor itself is untouched: a style attribute there would fail the
    // contract that lets this field through unescaped in the first place.
    expect(html).toContain('<a href="https://x.test">blog</a>');
  });

  it("emits no link rule when the theme sets no link colour", () => {
    const { html } = renderBlocks(BODY, { theme: { contentWidth: 720 } });
    expect(html).not.toContain("x-apple-data-detectors");
  });

  it("rounds the card to the corner style it is given", () => {
    expect(
      renderBlocks(BODY, { theme: { cardCorners: "sharp" } }).html,
    ).toContain("border-radius:0");
    expect(
      renderBlocks(BODY, { theme: { cardCorners: "pill" } }).html,
    ).toContain("border-radius:999px");
  });

  it("leaves the plain-text part alone — a theme is not text", () => {
    expect(renderBlocks(BODY, { theme: { font: "mono" } }).text).toBe(
      renderBlocks(BODY).text,
    );
  });
});

describe("the theme contract", () => {
  it("refuses anything that is not six hex digits", () => {
    for (const pageBackground of ["white", "rgb(0,0,0)", "#fff", "url(x)"])
      expect(CampaignTheme.safeParse({ pageBackground }).success).toBe(false);
  });

  it("refuses a width that is not one of the presets", () => {
    expect(CampaignTheme.safeParse({ contentWidth: 640 }).success).toBe(false);
    expect(CampaignTheme.safeParse({ contentWidth: 600 }).success).toBe(true);
  });

  it("refuses a font that is not one of the three stacks", () => {
    expect(CampaignTheme.safeParse({ font: "Comic Sans" }).success).toBe(false);
  });

  it("accepts the empty theme", () => {
    expect(CampaignTheme.safeParse({}).success).toBe(true);
  });
});
