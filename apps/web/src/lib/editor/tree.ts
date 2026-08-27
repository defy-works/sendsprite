import {
  COLUMN_COUNT,
  MAX_BLOCKS_PER_COLUMN,
  type CampaignBlock,
  type ColumnLayout,
  type LeafBlock,
} from "@sendsprite/shared";
import { newBlockId } from "./blocks";

/**
 * The campaign body as the editor holds it: a tree, not a list.
 *
 * A body is now a sequence of *nodes*, each of which is either a leaf block or
 * a row of columns holding leaf blocks. Two things follow, and they are the
 * reason this is a module of pure functions rather than state inside the
 * editor component:
 *
 * 1. **Dragging is a tree operation.** Moving a block out of the left column
 *    of a row and into the right column of the row below is one move that
 *    touches four arrays. Expressed as `setState` callbacks inside a drag
 *    handler it is unreadable and untestable; expressed as
 *    `moveItem(nodes, id, container, index)` it is neither.
 * 2. **The invariants are structural.** A row may not contain a row. A row
 *    must have exactly as many columns as its layout says. A column holds at
 *    most `MAX_BLOCKS_PER_COLUMN`. Every function below preserves all three,
 *    and the contract re-checks them on save — but a UI that can *express* an
 *    invalid tree will produce one, and the author will lose work to a refusal
 *    they cannot see the cause of.
 *
 * Editor ids are local to the session and never stored; `blocksOf` strips
 * them. See `preview.ts` for why an array index cannot be the id.
 */

export interface EditorLeaf {
  id: string;
  type: "leaf";
  block: LeafBlock;
}

export interface EditorRow {
  id: string;
  type: "row";
  layout: ColumnLayout;
  background?: string;
  /** The gutter between columns. Absent is the renderer's 16px. */
  gap?: number;
  spaceTop?: number;
  spaceBottom?: number;
  columns: EditorLeaf[][];
}

export type EditorNode = EditorLeaf | EditorRow;

/**
 * Where a drag can drop.
 *
 * `"root"` is the body itself; `row:<id>:<n>` is the nth column of a row. A
 * string rather than an object because dnd-kit identifies droppables by id,
 * and parsing one string is cheaper than keeping a parallel map in sync with
 * a tree that changes on every drag frame.
 */
export type ContainerId = "root" | `row:${string}:${number}`;

export const columnContainer = (rowId: string, index: number): ContainerId =>
  `row:${rowId}:${index}`;

export function parseContainer(
  id: string,
): { kind: "root" } | { kind: "column"; rowId: string; index: number } | null {
  if (id === "root") return { kind: "root" };
  const m = /^row:(.+):(\d+)$/.exec(id);
  if (!m) return null;
  return { kind: "column", rowId: m[1]!, index: Number(m[2]) };
}

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

export const editorLeaf = (block: LeafBlock): EditorLeaf => ({
  id: newBlockId(),
  type: "leaf",
  block,
});

/** A row with the right number of empty columns for its layout. */
export function editorRow(layout: ColumnLayout): EditorRow {
  return {
    id: newBlockId(),
    type: "row",
    layout,
    columns: Array.from({ length: COLUMN_COUNT[layout] }, () => []),
  };
}

/** A stored body as the editor holds it. */
export function editorNodesOf(blocks: readonly CampaignBlock[]): EditorNode[] {
  return blocks.map((b) =>
    b.kind === "columns"
      ? {
          id: newBlockId(),
          type: "row" as const,
          layout: b.layout,
          ...(b.background ? { background: b.background } : {}),
          ...(b.gap === undefined ? {} : { gap: b.gap }),
          ...(b.spaceTop === undefined ? {} : { spaceTop: b.spaceTop }),
          ...(b.spaceBottom === undefined
            ? {}
            : { spaceBottom: b.spaceBottom }),
          columns: b.columns.map((col) => col.map(editorLeaf)),
        }
      : editorLeaf(b),
  );
}

/** The editor's tree as the contract stores it. */
export function blocksOfTree(nodes: readonly EditorNode[]): CampaignBlock[] {
  return nodes.map((n) =>
    n.type === "leaf"
      ? n.block
      : {
          kind: "columns" as const,
          layout: n.layout,
          ...(n.background ? { background: n.background } : {}),
          // Only when set, and never as `0`: the renderer writes no vertical
          // padding for an absent value, which is what keeps a body written
          // before spacing existed rendering byte for byte as it did.
          ...(n.gap ? { gap: n.gap } : {}),
          ...(n.spaceTop ? { spaceTop: n.spaceTop } : {}),
          ...(n.spaceBottom ? { spaceBottom: n.spaceBottom } : {}),
          columns: n.columns.map((col) => col.map((l) => l.block)),
        },
  );
}

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

export interface Located {
  container: ContainerId;
  index: number;
  node: EditorNode;
}

/** Where an id lives, or null. Searches rows as well as the root. */
export function locate(
  nodes: readonly EditorNode[],
  id: string,
): Located | null {
  const rootIndex = nodes.findIndex((n) => n.id === id);
  if (rootIndex !== -1)
    return { container: "root", index: rootIndex, node: nodes[rootIndex]! };
  for (const n of nodes) {
    if (n.type !== "row") continue;
    for (let c = 0; c < n.columns.length; c++) {
      const i = n.columns[c]!.findIndex((l) => l.id === id);
      if (i !== -1)
        return {
          container: columnContainer(n.id, c),
          index: i,
          node: n.columns[c]![i]!,
        };
    }
  }
  return null;
}

/** The ids inside one container, in order. `[]` for an unknown container. */
export function itemsIn(
  nodes: readonly EditorNode[],
  container: ContainerId,
): string[] {
  const parsed = parseContainer(container);
  if (!parsed) return [];
  if (parsed.kind === "root") return nodes.map((n) => n.id);
  const row = nodes.find(
    (n): n is EditorRow => n.type === "row" && n.id === parsed.rowId,
  );
  return row?.columns[parsed.index]?.map((l) => l.id) ?? [];
}

/** Every container that currently exists, root first. */
export function containers(nodes: readonly EditorNode[]): ContainerId[] {
  const out: ContainerId[] = ["root"];
  for (const n of nodes)
    if (n.type === "row")
      for (let c = 0; c < n.columns.length; c++)
        out.push(columnContainer(n.id, c));
  return out;
}

/* ------------------------------------------------------------------ *
 * Mutation — every one of these returns a new tree
 * ------------------------------------------------------------------ */

/** Removes an id from wherever it is. Returns the tree unchanged if absent. */
export function removeNode(
  nodes: readonly EditorNode[],
  id: string,
): EditorNode[] {
  if (nodes.some((n) => n.id === id)) return nodes.filter((n) => n.id !== id);
  return nodes.map((n) =>
    n.type === "row"
      ? {
          ...n,
          columns: n.columns.map((col) => col.filter((l) => l.id !== id)),
        }
      : n,
  );
}

/**
 * Inserts a node into a container at an index.
 *
 * A row is only ever inserted at the root: the contract forbids nesting, and
 * silently dropping the drag is better than silently flattening the row into
 * the column, which would lose its other columns without saying so.
 */
export function insertNode(
  nodes: readonly EditorNode[],
  container: ContainerId,
  index: number,
  node: EditorNode,
): EditorNode[] {
  const parsed = parseContainer(container);
  if (!parsed) return [...nodes];
  if (parsed.kind === "root") {
    const next = [...nodes];
    next.splice(clamp(index, next.length), 0, node);
    return next;
  }
  if (node.type !== "leaf") return [...nodes];
  return nodes.map((n) => {
    if (n.type !== "row" || n.id !== parsed.rowId) return n;
    const col = n.columns[parsed.index];
    if (!col || col.length >= MAX_BLOCKS_PER_COLUMN) return n;
    const nextCol = [...col];
    nextCol.splice(clamp(index, nextCol.length), 0, node);
    return {
      ...n,
      columns: n.columns.map((c, i) => (i === parsed.index ? nextCol : c)),
    };
  });
}

/**
 * Moves an existing id to a container and index.
 *
 * Remove-then-insert rather than a splice pair, because the source and target
 * containers may be the same array, may be different columns of the same row,
 * or may be root and a column of a row that is itself being moved — and every
 * one of those needs the indices recomputed *after* the removal. Doing it in
 * two steps is the version that is obviously right rather than the version
 * that is one off in three of the four cases.
 */
export function moveItem(
  nodes: readonly EditorNode[],
  id: string,
  toContainer: ContainerId,
  toIndex: number,
): EditorNode[] {
  const found = locate(nodes, id);
  if (!found) return [...nodes];
  const target = parseContainer(toContainer);
  if (!target) return [...nodes];
  // A row cannot go inside a column; refuse rather than mangle.
  if (found.node.type === "row" && target.kind !== "root") return [...nodes];
  // Nothing to do, and doing it anyway would renumber for no reason.
  if (found.container === toContainer && found.index === toIndex)
    return [...nodes];
  // A column that is full refuses the drop, so the block stays where it was
  // rather than vanishing between the remove and the insert.
  if (target.kind === "column" && found.container !== toContainer) {
    const room = itemsIn(nodes, toContainer).length < MAX_BLOCKS_PER_COLUMN;
    if (!room) return [...nodes];
  }
  const without = removeNode(nodes, id);
  return insertNode(without, toContainer, toIndex, found.node);
}

/** Replaces the block inside a leaf, wherever it is. */
export function replaceLeaf(
  nodes: readonly EditorNode[],
  id: string,
  block: LeafBlock,
): EditorNode[] {
  return nodes.map((n) => {
    if (n.type === "leaf") return n.id === id ? { ...n, block } : n;
    return {
      ...n,
      columns: n.columns.map((col) =>
        col.map((l) => (l.id === id ? { ...l, block } : l)),
      ),
    };
  });
}

/** Replaces a row's own fields (layout, background) without touching content. */
export function updateRow(
  nodes: readonly EditorNode[],
  id: string,
  patch: Partial<
    Pick<
      EditorRow,
      "layout" | "background" | "gap" | "spaceTop" | "spaceBottom"
    >
  >,
): EditorNode[] {
  return nodes.map((n) => {
    if (n.type !== "row" || n.id !== id) return n;
    const next: EditorRow = { ...n, ...patch };
    // An explicit `undefined` in the patch means "clear it", which is not the
    // same as leaving the key off — spreading would otherwise store the key
    // with an undefined value and serialise it into the body.
    for (const k of ["background", "gap", "spaceTop", "spaceBottom"] as const)
      if (k in patch && patch[k] === undefined) delete next[k];
    return patch.layout ? relayout(next, patch.layout) : next;
  });
}

/**
 * Changes a row's layout, keeping as much content as the new shape can hold.
 *
 * Going from three columns to two has to put the third column's blocks
 * somewhere, and the only two honest options are "append them to the last
 * surviving column" or "delete them". Appending is recoverable — the author
 * sees them and can drag them back — and deletion is not, so the blocks move.
 * Going the other way adds empty columns.
 */
function relayout(row: EditorRow, layout: ColumnLayout): EditorRow {
  const want = COLUMN_COUNT[layout];
  const columns = row.columns.slice(0, want).map((c) => [...c]);
  while (columns.length < want) columns.push([]);
  const orphans = row.columns.slice(want).flat();
  if (orphans.length > 0) {
    const last = columns[columns.length - 1]!;
    // The cap is the contract's; overflow is dropped rather than saved into a
    // body the service would refuse in full.
    last.push(...orphans.slice(0, MAX_BLOCKS_PER_COLUMN - last.length));
  }
  return { ...row, layout, columns };
}

const clamp = (i: number, max: number) => Math.max(0, Math.min(i, max));
