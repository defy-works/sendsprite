import { describe, expect, it } from "vitest";
import { MAX_BLOCKS_PER_COLUMN, type LeafBlock } from "@sendsprite/shared";
import { blockDefaults } from "@/app/app/campaigns/preview";
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
} from "@/app/app/campaigns/tree";

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
  it("round-trips a body with rows and leaves", () => {
    const blocks = [
      blockDefaults("heading"),
      {
        kind: "columns" as const,
        layout: "1-1" as const,
        columns: [[blockDefaults("text")], [blockDefaults("button")]],
      },
      blockDefaults("divider"),
    ];
    expect(blocksOfTree(editorNodesOf(blocks))).toEqual(blocks);
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
    const a = leaf("heading");
    const b = leaf("text");
    const c = leaf("divider");
    const moved = moveItem([a, b, c], c.id, "root", 0);
    expect(moved.map((n) => n.id)).toEqual([c.id, a.id, b.id]);
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
