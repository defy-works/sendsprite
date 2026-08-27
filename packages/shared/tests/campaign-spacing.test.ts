import { describe, expect, it } from "vitest";
import {
  CampaignBlock,
  ColumnsBlock,
  CampaignTheme,
  renderBlocks,
  type CampaignBlock as Block,
} from "../src";

const TEXT: Block = { kind: "text", html: "Hello" };

const html = (blocks: Block[], theme?: unknown) =>
  renderBlocks(blocks, theme ? { theme: theme as never } : {}).html;

describe("block spacing", () => {
  it("writes no vertical padding when a block asks for none", () => {
    // The whole reason spacing could be added to a live table with no
    // backfill: absent means the string this always rendered.
    expect(html([TEXT])).toContain('style="padding:0 24px"');
  });

  it("writes the padding a block asks for, on the row that positions it", () => {
    expect(html([{ ...TEXT, spaceTop: 40, spaceBottom: 8 }])).toContain(
      'style="padding:40px 24px 8px"',
    );
  });

  it("writes one side alone", () => {
    expect(html([{ ...TEXT, spaceTop: 32 }])).toContain(
      'style="padding:32px 24px 0px"',
    );
    expect(html([{ ...TEXT, spaceBottom: 32 }])).toContain(
      'style="padding:0px 24px 32px"',
    );
  });

  it("spaces a leaf inside a column with a div, not with cell padding", () => {
    // Outlook adds cell padding to the cell's width, and the cell carries the
    // column's width — so padding there overflows the row by exactly that.
    const row: Block = {
      kind: "columns",
      layout: "1-1",
      columns: [[{ ...TEXT, spaceTop: 12, spaceBottom: 4 }], [TEXT]],
    };
    const out = html([row]);
    expect(out).toContain('<div style="padding:12px 0 4px">');
    expect(out).not.toContain("padding:12px 0 4px;width");
  });

  it("leaves an unspaced leaf in a column unwrapped", () => {
    const row: Block = {
      kind: "columns",
      layout: "1-1",
      columns: [[TEXT], [TEXT]],
    };
    expect(html([row])).not.toContain('<div style="padding:0px 0 0px">');
  });

  it("spaces the row itself", () => {
    const row: Block = {
      kind: "columns",
      layout: "1-1",
      columns: [[TEXT], [TEXT]],
      spaceTop: 24,
      spaceBottom: 24,
    };
    expect(html([row])).toContain('style="padding:24px 24px 24px;"');
  });
});

describe("the column gap", () => {
  const rowWith = (gap?: number): Block => ({
    kind: "columns",
    layout: "1-1",
    ...(gap === undefined ? {} : { gap }),
    columns: [[TEXT], [TEXT]],
  });

  it("defaults to 16 and is written on the spacer cell", () => {
    expect(html([rowWith()])).toContain('width="16"');
  });

  it("resizes the spacer cell and the columns together", () => {
    const out = html([rowWith(48)]);
    expect(out).toContain('width="48"');
    // 600 card − 24 each side = 552 usable; 552 − 48 gutter = 504, halved.
    expect(out).toContain('width="252"');
  });

  it("still totals the usable width exactly, at every layout and gap", () => {
    // A row one pixel over is a row Outlook wraps, which is the whole reason
    // the widths are computed rather than expressed as percentages.
    for (const layout of ["1-1", "1-1-1", "2-1", "1-2"] as const) {
      for (const gap of [0, 1, 7, 16, 48]) {
        const columns = Array.from(
          { length: layout === "1-1-1" ? 3 : 2 },
          () => [TEXT],
        );
        const out = html([{ kind: "columns", layout, gap, columns }]);
        const widths = [...out.matchAll(/<td class="ss-col" width="(\d+)"/g)]
          .map((m) => Number(m[1]))
          .reduce((a, b) => a + b, 0);
        const gaps = (columns.length - 1) * gap;
        expect(widths + gaps).toBe(552);
      }
    }
  });

  it("is refused outside 0–48", () => {
    const bad = { kind: "columns", layout: "1-1", gap: 49, columns: [[], []] };
    expect(ColumnsBlock.safeParse(bad).success).toBe(false);
  });
});

describe("the card's own gutter", () => {
  it("defaults to 24 and is what the blocks are padded by", () => {
    expect(html([TEXT])).toContain("padding:0 24px");
  });

  it("moves every edge together when the theme sets it", () => {
    const out = html([TEXT], { contentPadding: 8 });
    expect(out).toContain("padding:0 8px");
    expect(out).not.toContain("padding:0 24px");
  });

  it("changes what a full-width image is sized against", () => {
    // 600 − 2×8 = 584, where the default gutter would have given 552.
    const out = html([{ kind: "image", url: "https://x.io/a.png", alt: "a" }], {
      contentPadding: 8,
    });
    expect(out).toContain('width="584"');
  });

  it("is refused outside 0–64", () => {
    expect(CampaignTheme.safeParse({ contentPadding: 65 }).success).toBe(false);
    expect(CampaignTheme.safeParse({ contentPadding: 0 }).success).toBe(true);
  });
});

describe("the spacing contract", () => {
  it("accepts 0 through 96 and nothing else", () => {
    for (const v of [0, 1, 96])
      expect(CampaignBlock.safeParse({ ...TEXT, spaceTop: v }).success).toBe(
        true,
      );
    for (const v of [-1, 97, 1.5])
      expect(CampaignBlock.safeParse({ ...TEXT, spaceTop: v }).success).toBe(
        false,
      );
  });

  it("does not give the spacer block spacing of its own", () => {
    // A block whose entire content is space has no use for space around it.
    const parsed = CampaignBlock.parse({
      kind: "spacer",
      size: 24,
      spaceTop: 40,
    });
    expect(parsed).toEqual({ kind: "spacer", size: 24 });
  });
});
