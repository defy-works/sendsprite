import { describe, expect, it } from "vitest";
import { renderBlocks } from "../src/campaign-render";
import {
  CampaignBlock,
  COLUMN_COUNT,
  COLUMN_LAYOUTS,
  ColumnsBlock,
  MAX_BLOCKS_PER_COLUMN,
  type ColumnLayout,
} from "../src/api/campaigns";

const render = (blocks: CampaignBlock[]) => renderBlocks(blocks);

const row = (
  layout: ColumnLayout,
  columns: CampaignBlock[][],
  background?: string,
): CampaignBlock =>
  ({
    kind: "columns",
    layout,
    ...(background ? { background } : {}),
    columns,
  }) as CampaignBlock;

const text = (s: string): CampaignBlock => ({ kind: "text", html: s });

/** Every `width="…"` in the document, in order — cells and gutters alike. */
const widths = (html: string) =>
  [...html.matchAll(/width="(\d+)"/g)].map((m) => Number(m[1]));

/** Just the content cells, which is what a ratio is about. */
const colWidths = (html: string) =>
  [...html.matchAll(/class="ss-col" width="(\d+)"/g)].map((m) => Number(m[1]));

describe("the columns block", () => {
  it("renders one cell per column, in order", () => {
    const { html } = render([row("1-1", [[text("left")], [text("right")]])]);
    expect(html.indexOf("left")).toBeGreaterThan(-1);
    expect(html.indexOf("left")).toBeLessThan(html.indexOf("right"));
    expect([...html.matchAll(/class="ss-col"/g)]).toHaveLength(2);
  });

  /**
   * The single most important property here. Outlook on Windows lays a row out
   * against the pixel widths, and a row whose cells plus gutters exceed the
   * card wraps the last column onto its own line — the classic "it looks fine
   * everywhere except Outlook" bug. Asserting the arithmetic is what stops a
   * later change to the gutter or the card width from reintroducing it.
   */
  it.each(COLUMN_LAYOUTS)(
    "totals exactly the content width for the %s layout",
    (layout) => {
      // Every layout, at whatever number of columns it declares — including
      // the row of one, whose single cell has to be the whole content width.
      const columns = Array.from({ length: COLUMN_COUNT[layout] }, () => [
        text("x"),
      ]);
      const { html } = render([row(layout, columns)]);
      // The card itself is 600 wide; everything after it is a column cell or
      // a gutter cell, and the two together must fill the content width
      // exactly — a pixel over and Outlook wraps the last column.
      const cells = widths(html).filter((w) => w !== 600);
      expect(cells.reduce((a, b) => a + b, 0)).toBe(552);
    },
  );

  it("gives the wide column of 2-1 twice the narrow one, near enough", () => {
    const { html } = render([row("2-1", [[text("a")], [text("b")]])]);
    const [wide, narrow] = colWidths(html);
    expect(wide).toBeGreaterThan(narrow!);
    expect((wide as number) / (narrow as number)).toBeCloseTo(2, 0);
  });

  it("mirrors 2-1 for 1-2", () => {
    const wideFirst = colWidths(
      render([row("2-1", [[text("a")], [text("b")]])]).html,
    );
    const wideSecond = colWidths(
      render([row("1-2", [[text("a")], [text("b")]])]).html,
    );
    expect(wideSecond).toEqual([...wideFirst].reverse());
  });

  it("ships the media query that stacks columns on a phone", () => {
    const { html } = render([row("1-1", [[text("a")], [text("b")]])]);
    expect(html).toContain("@media only screen and (max-width:620px)");
    expect(html).toMatch(/\.ss-col\{[^}]*display:block!important/);
  });

  it("renders an empty column rather than collapsing the row", () => {
    const { html } = render([row("1-1", [[text("only")], []])]);
    expect([...html.matchAll(/class="ss-col"/g)]).toHaveLength(2);
  });

  it("paints a row background when one is set", () => {
    const { html } = render([
      row("1-1", [[text("a")], [text("b")]], "#fef3c7"),
    ]);
    expect(html).toContain("background:#fef3c7");
  });

  /**
   * A text part has no columns, so the only ordering it can offer is reading
   * order. Left column then right, which is what a screen reader does with the
   * HTML too.
   */
  it("flattens columns into reading order in the text part", () => {
    const { text: plain } = render([
      row("1-1-1", [[text("one")], [text("two")], [text("three")]]),
    ]);
    expect(plain.indexOf("one")).toBeLessThan(plain.indexOf("two"));
    expect(plain.indexOf("two")).toBeLessThan(plain.indexOf("three"));
  });

  it("sizes an image against its column, not against the card", () => {
    const image = (): CampaignBlock => ({
      kind: "image",
      url: "https://cdn.test/a.png",
      alt: "A",
    });
    const inRow = render([row("1-1", [[image()], []])]).html;
    const alone = render([image()]).html;
    expect(alone).toContain("max-width:552px");
    // Half the usable width, minus its share of the gutter.
    expect(inRow).toContain("max-width:268px");
  });
});

describe("the columns contract", () => {
  it("refuses a layout whose column count does not match", () => {
    const bad = ColumnsBlock.safeParse({
      kind: "columns",
      layout: "1-1-1",
      columns: [[], []],
    });
    expect(bad.success).toBe(false);
    if (bad.success) return;
    expect(bad.error.issues[0]?.message).toContain("1-1-1 layout has 3");
  });

  /**
   * The bound that keeps the renderer honest: a row inside a row is where
   * email layout stops being portable, and refusing it in the schema means the
   * renderer never has to have an opinion about depth.
   */
  it("refuses a row nested inside a column", () => {
    const nested = ColumnsBlock.safeParse({
      kind: "columns",
      layout: "1-1",
      columns: [[{ kind: "columns", layout: "1-1", columns: [[], []] }], []],
    });
    expect(nested.success).toBe(false);
  });

  it("caps the blocks in one column", () => {
    const tooMany = ColumnsBlock.safeParse({
      kind: "columns",
      layout: "1-1",
      columns: [
        Array.from({ length: MAX_BLOCKS_PER_COLUMN + 1 }, () => ({
          kind: "divider",
        })),
        [],
      ],
    });
    expect(tooMany.success).toBe(false);
  });

  it("still accepts every leaf kind on its own", () => {
    for (const b of [
      { kind: "heading", level: 2, text: "H" },
      { kind: "text", html: "T" },
      { kind: "button", label: "B", url: "https://x.test" },
      { kind: "image", url: "https://x.test/a.png", alt: "A" },
      { kind: "divider" },
      { kind: "spacer", size: 8 },
    ])
      expect(CampaignBlock.safeParse(b).success).toBe(true);
  });
});

describe("block presentation", () => {
  it("applies alignment to a heading and a paragraph", () => {
    const { html } = render([
      { kind: "heading", level: 2, text: "Centred", align: "center" },
      { kind: "text", html: "Right", align: "right" },
    ]);
    expect(html).toContain("text-align:center");
    expect(html).toContain("text-align:right");
  });

  it("uses the author's colours where they set them and defaults elsewhere", () => {
    const { html } = render([
      { kind: "heading", level: 1, text: "H", color: "#dc2626" },
      { kind: "text", html: "T" },
    ]);
    expect(html).toContain("color:#dc2626");
    expect(html).toContain("color:#111111");
  });

  it("renders a pill button in the colours it was given", () => {
    const { html } = render([
      {
        kind: "button",
        label: "Go",
        url: "https://x.test",
        color: "#059669",
        textColor: "#111111",
        corners: "pill",
      },
    ]);
    expect(html).toContain("background:#059669");
    expect(html).toContain("color:#111111");
    expect(html).toContain("border-radius:999px");
  });

  it("scales an image by its width percentage", () => {
    const { html } = render([
      {
        kind: "image",
        url: "https://cdn.test/a.png",
        alt: "A",
        width: 50,
      },
    ]);
    expect(html).toContain("max-width:276px");
  });

  it("colours a divider", () => {
    const { html } = render([{ kind: "divider", color: "#4f46e5" }]);
    expect(html).toContain("border-top:1px solid #4f46e5");
  });

  /**
   * The whole reason presentation is an enum and a hex pattern rather than a
   * style string: a colour is the one place an author's value would otherwise
   * land inside a `style` attribute, where escaping does nothing.
   */
  it("refuses a colour that is not six hex digits", () => {
    for (const color of [
      "red",
      "rgb(1,2,3)",
      "#fff",
      'x" onload="alert(1)',
      "var(--x)",
    ])
      expect(CampaignBlock.safeParse({ kind: "divider", color }).success).toBe(
        false,
      );
  });
});
