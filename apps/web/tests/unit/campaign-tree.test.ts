import { describe, expect, it } from "vitest";
import {
  MAX_BLOCKS_PER_COLUMN,
  type CampaignBlock,
  type LeafBlock,
} from "@sendsprite/shared";
import { blockDefaults } from "@/lib/editor/blocks";
import {
  blocksOfTree,
  columnContainer,
  containers,
  editorLeaf,
  editorNodesOf,
  editorRow,
  insertNode,
  itemsIn,
  locate,
  moveItem,
  parseContainer,
  removeNode,
  replaceLeaf,
  updateRow,
  type EditorNode,
  type EditorRow,
} from "@/lib/editor/tree";

/**
 * The tree is where a drag actually happens, and a drag is the one interaction
 * in this product that cannot be verified by reading the code: "moved the
 * button out of the left column into the right column of the row below" is
 * four array mutations whose indices depend on each other. These are the
 * assertions that make that reviewable.
 */

const leaf = (kind: Parameters<typeof blockDefaults>[0] = "text") =>
  editorLeaf(blockDefaults(kind));

const rowWith = (
  layout: Parameters<typeof editorRow>[0],
  columns: ReturnType<typeof leaf>[][],
): EditorRow => ({ ...editorRow(layout), columns });

describe("editorNodesOf / blocksOfTree", () => {
  it("round-trips a body of rows unchanged", () => {
    const blocks: CampaignBlock[] = [
      {
        kind: "columns",
        layout: "1",
        columns: [[blockDefaults("heading")]],
      },
      {
        kind: "columns",
        layout: "1-1",
        columns: [[blockDefaults("text")], [blockDefaults("button")]],
      },
    ];
    expect(blocksOfTree(editorNodesOf(blocks))).toEqual(blocks);
  });

  it("wraps a bare leaf in a row of one column", () => {
    // The body is a list of rows. A leaf straight in it — which is what the
    // API accepts and what every body written before this did — comes back
    // wrapped, so an ordinary paragraph has the same settings a column does.
    // One column at the full content width renders what a bare leaf rendered.
    const heading = blockDefaults("heading");
    expect(blocksOfTree(editorNodesOf([heading]))).toEqual([
      { kind: "columns", layout: "1", columns: [[heading]] },
    ]);
  });

  it("keeps a row background and omits it when unset", () => {
    const withBg = editorNodesOf([
      {
        kind: "columns",
        layout: "1-1",
        background: "#f3f4f6",
        columns: [[], []],
      },
    ]);
    expect(blocksOfTree(withBg)[0]).toMatchObject({ background: "#f3f4f6" });
    // Absent rather than `undefined`: the contract marks it `.optional()`, and
    // an explicit `undefined` survives `JSON.stringify` as a missing key in
    // one direction and a present one in the other — which is exactly the
    // difference the dirty check compares.
    const without = editorNodesOf([
      { kind: "columns", layout: "1-1", columns: [[], []] },
    ]);
    expect("background" in (blocksOfTree(without)[0] as object)).toBe(false);
  });

  it("gives every node and nested leaf a distinct id", () => {
    const nodes = editorNodesOf([
      blockDefaults("heading"),
      {
        kind: "columns",
        layout: "1-1-1",
        columns: [
          [blockDefaults("text")],
          [blockDefaults("text")],
          [blockDefaults("text")],
        ],
      },
    ]);
    const ids = [
      ...nodes.map((n) => n.id),
      ...nodes.flatMap((n) =>
        n.type === "row" ? n.columns.flat().map((l) => l.id) : [],
      ),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("containers", () => {
  it("parses a column container id and rejects anything else", () => {
    expect(parseContainer("root")).toEqual({ kind: "root" });
    expect(parseContainer("row:abc:2")).toEqual({
      kind: "column",
      rowId: "abc",
      index: 2,
    });
    expect(parseContainer("blk-x-1")).toBeNull();
    expect(parseContainer("row:abc")).toBeNull();
  });

  it("survives a row id that itself contains colons", () => {
    // Editor ids are `blk-<prefix>-<n>` today. The parser is greedy on the id
    // and anchored on the trailing number precisely so that stays an
    // implementation detail rather than a constraint.
    expect(parseContainer("row:a:b:c:1")).toEqual({
      kind: "column",
      rowId: "a:b:c",
      index: 1,
    });
  });

  it("lists the root plus one per column", () => {
    const row = editorRow("1-1-1");
    expect(containers([leaf(), row])).toEqual([
      "root",
      columnContainer(row.id, 0),
      columnContainer(row.id, 1),
      columnContainer(row.id, 2),
    ]);
  });
});

describe("locate", () => {
  it("finds a leaf at the root and inside a column", () => {
    const top = leaf("heading");
    const nested = leaf("button");
    const row = rowWith("1-1", [[nested], []]);
    const nodes = [top, row];
    expect(locate(nodes, top.id)).toMatchObject({
      container: "root",
      index: 0,
    });
    expect(locate(nodes, nested.id)).toMatchObject({
      container: columnContainer(row.id, 0),
      index: 0,
    });
    expect(locate(nodes, "nope")).toBeNull();
  });
});

describe("moveItem", () => {
  it("reorders at the root", () => {
    // The root holds rows, so this is what reordering the body is.
    const a = rowWith("1", [[]]);
    const b = rowWith("1", [[]]);
    const c = rowWith("1", [[]]);
    const moved = moveItem([a, b, c], c.id, "root", 0);
    expect(moved.map((n) => n.id)).toEqual([c.id, a.id, b.id]);
  });

  it("gives a leaf dragged out of a column a row of its own", () => {
    const orphan = leaf("button");
    const row = rowWith("1-1", [[orphan], []]);
    const moved = moveItem([row], orphan.id, "root", 0);
    const [first] = moved;
    expect(first?.type).toBe("row");
    expect(first?.type === "row" && first.layout).toBe("1");
    expect(itemsIn(moved, columnContainer(first!.id, 0))).toEqual([orphan.id]);
  });

  it("moves a leaf from the root into a column", () => {
    const orphan = leaf("button");
    const row = rowWith("1-1", [[], []]);
    const target = columnContainer(row.id, 1);
    const moved = moveItem([orphan, row], orphan.id, target, 0);
    expect(moved).toHaveLength(1);
    expect(itemsIn(moved, target)).toEqual([orphan.id]);
  });

  it("moves a leaf between two columns of the same row", () => {
    const l = leaf("image");
    const row = rowWith("1-1", [[l], []]);
    const to = columnContainer(row.id, 1);
    const moved = moveItem([row], l.id, to, 0);
    expect(itemsIn(moved, columnContainer(row.id, 0))).toEqual([]);
    expect(itemsIn(moved, to)).toEqual([l.id]);
  });

  it("moves a leaf between two different rows", () => {
    const l = leaf("text");
    const from = rowWith("1-1", [[l], []]);
    const to = rowWith("1-1-1", [[], [], []]);
    const target = columnContainer(to.id, 2);
    const moved = moveItem([from, to], l.id, target, 0);
    expect(itemsIn(moved, columnContainer(from.id, 0))).toEqual([]);
    expect(itemsIn(moved, target)).toEqual([l.id]);
  });

  it("refuses to put a row inside a column", () => {
    const inner = editorRow("1-1");
    const outer = rowWith("1-1", [[], []]);
    const nodes = [inner, outer];
    expect(moveItem(nodes, inner.id, columnContainer(outer.id, 0), 0)).toEqual(
      nodes,
    );
  });

  it("refuses a drop into a column that is already full", () => {
    const full = Array.from({ length: MAX_BLOCKS_PER_COLUMN }, () =>
      leaf("divider"),
    );
    const row = rowWith("1-1", [full, []]);
    const orphan = leaf("text");
    const nodes = [orphan, row];
    const moved = moveItem(nodes, orphan.id, columnContainer(row.id, 0), 0);
    // Unchanged, and — the part that matters — the block is still in the tree
    // rather than lost between the remove and the refused insert.
    expect(locate(moved, orphan.id)).not.toBeNull();
    expect(itemsIn(moved, columnContainer(row.id, 0))).toHaveLength(
      MAX_BLOCKS_PER_COLUMN,
    );
  });

  it("is a no-op when the destination is where it already is", () => {
    const a = leaf();
    const b = leaf();
    const nodes: EditorNode[] = [a, b];
    expect(moveItem(nodes, a.id, "root", 0).map((n) => n.id)).toEqual([
      a.id,
      b.id,
    ]);
  });

  it("does not mutate the tree it was given", () => {
    const a = leaf();
    const b = leaf();
    const nodes = [a, b];
    moveItem(nodes, b.id, "root", 0);
    expect(nodes.map((n) => n.id)).toEqual([a.id, b.id]);
  });
});

describe("insertNode / removeNode / replaceLeaf", () => {
  it("inserts into a column and refuses a row there", () => {
    const row = rowWith("1-1", [[], []]);
    const target = columnContainer(row.id, 0);
    const l = leaf("heading");
    expect(itemsIn(insertNode([row], target, 0, l), target)).toEqual([l.id]);
    expect(insertNode([row], target, 0, editorRow("1-1"))).toEqual([row]);
  });

  it("removes a nested leaf without touching its siblings", () => {
    const a = leaf();
    const b = leaf();
    const row = rowWith("1-1", [[a, b], []]);
    const next = removeNode([row], a.id);
    expect(itemsIn(next, columnContainer(row.id, 0))).toEqual([b.id]);
  });

  it("replaces a nested leaf's block", () => {
    const l = leaf("text");
    const row = rowWith("1-1", [[l], []]);
    const replacement: LeafBlock = { kind: "text", html: "changed" };
    const next = replaceLeaf([row], l.id, replacement);
    const updated = next[0] as EditorRow;
    expect(updated.columns[0]?.[0]?.block).toEqual(replacement);
  });
});

describe("updateRow", () => {
  it("adds empty columns when the layout widens", () => {
    const row = rowWith("1-1", [[leaf()], [leaf()]]);
    const next = updateRow([row], row.id, { layout: "1-1-1" })[0] as EditorRow;
    expect(next.layout).toBe("1-1-1");
    expect(next.columns).toHaveLength(3);
    expect(next.columns[2]).toEqual([]);
  });

  /**
   * The alternative was deleting them. Appending is recoverable — the author
   * can see the blocks and drag them back — and a silent delete of somebody's
   * work is not, so the trade is made in that direction on purpose.
   */
  it("moves orphaned blocks into the last column when the layout narrows", () => {
    const kept = leaf("heading");
    const orphan = leaf("button");
    const row = rowWith("1-1-1", [[], [kept], [orphan]]);
    const next = updateRow([row], row.id, { layout: "1-1" })[0] as EditorRow;
    expect(next.columns).toHaveLength(2);
    expect(next.columns[1]?.map((l) => l.id)).toEqual([kept.id, orphan.id]);
  });

  it("clears a background when set to undefined", () => {
    const row: EditorRow = { ...editorRow("1-1"), background: "#ffffff" };
    const next = updateRow([row], row.id, {
      background: undefined,
    })[0] as EditorRow;
    expect(next.background).toBeUndefined();
  });
});

describe("row spacing round-trips", () => {
  it("carries gap and space through the editor and back", () => {
    const blocks: CampaignBlock[] = [
      {
        kind: "columns",
        layout: "1-1",
        gap: 32,
        spaceTop: 24,
        spaceBottom: 8,
        columns: [[{ kind: "text", html: "a" }], []],
      },
    ];
    expect(blocksOfTree(editorNodesOf(blocks))).toEqual(blocks);
  });

  it("keeps an unspaced row free of the keys entirely", () => {
    // A key holding `undefined` and an absent key are the same value and
    // different JSON, and the dirty check compares strings.
    const [row] = blocksOfTree(
      editorNodesOf([{ kind: "columns", layout: "1-1", columns: [[], []] }]),
    );
    expect(Object.keys(row!).sort()).toEqual(["columns", "kind", "layout"]);
  });

  it("clears a row field when the patch says undefined", () => {
    const nodes = editorNodesOf([
      {
        kind: "columns",
        layout: "1-1",
        gap: 32,
        spaceTop: 16,
        columns: [[], []],
      },
    ]);
    const id = nodes[0]!.id;
    const cleared = updateRow(nodes, id, { gap: undefined });
    const [row] = blocksOfTree(cleared);
    expect(row).not.toHaveProperty("gap");
    expect(row).toHaveProperty("spaceTop", 16);
  });
});
