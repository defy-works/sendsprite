"use client";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useState, type ReactNode } from "react";
import type {
  CampaignBlock,
  CampaignTheme,
  ColumnLayout,
  LeafBlock,
} from "@sendsprite/shared";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { IconChevronRight } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import {
  BLOCK_LABELS,
  blockDefaults,
  type LeafKind,
} from "@/lib/editor/blocks";
import {
  blocksOfTree,
  capacity,
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
  type ContainerId,
  type EditorNode,
} from "@/lib/editor/tree";
import { Canvas } from "./Canvas";
import { LeafInspector, RowInspector } from "./Inspector";
import { LayoutPicker } from "./LayoutPicker";
import { Palette, parsePaletteId } from "./Palette";
import { ThemePanel } from "./ThemePanel";

/**
 * The visual email editor: palette, canvas, inspector, and the drag logic that
 * connects them.
 *
 * One component for both the campaign editor and the template designer. They
 * differ in what they save and what they preview, not in how a body is built,
 * and the alternative — the campaign editor being the good one and the
 * template editor being a `<textarea>` — is the report this exists to answer.
 *
 * Everything structural lives in `lib/editor/tree.ts` as pure functions. What
 * is left here is the dnd-kit wiring and the three-column layout, which is
 * about as much as a component should own.
 */

/**
 * Drops land where the pointer is, and fall back to rectangles.
 *
 * `pointerWithin` alone cannot resolve a keyboard drag, which has no pointer;
 * `rectIntersection` alone picks the container with the largest overlap, which
 * for a small block hovering over a wide row is the row rather than the column
 * under the cursor. Trying the pointer first and falling back is what makes
 * both the mouse and the keyboard land where the user meant.
 */
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

export function BlockDesigner({
  nodes,
  onChange,
  theme,
  onThemeChange,
  readOnly,
  invalidIndex = null,
  settings,
  preview,
  bodyTitle = "Body",
}: {
  nodes: EditorNode[];
  onChange: (fn: (nodes: EditorNode[]) => EditorNode[]) => void;
  /** What the body as a whole looks like. `{}` is "the defaults". */
  theme: CampaignTheme;
  onThemeChange: (next: CampaignTheme) => void;
  readOnly: boolean;
  /** Index in `nodes` the preview blamed, which is the louder signal. */
  invalidIndex?: number | null;
  /** Rendered above the canvas — the fields that are not the body. */
  settings?: ReactNode;
  /**
   * The preview's *contents*, not a card.
   *
   * It shares the body card, so the title, the block count and the Edit /
   * Preview switch stay exactly where they are when the mode changes. Passing
   * a card would put a card inside a card and move the header, which is the
   * layout shift this arrangement exists to avoid.
   */
  preview: ReactNode;
  bodyTitle?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /**
   * Editing or reading.
   *
   * The canvas is faithful but it is not the email — it carries outlines, a
   * grip on hover and a drop zone at the end. Preview hides all of it and
   * hands the width to the frame that renders the real thing, which is the
   * check an author wants before sending and could previously only get by
   * squinting at a 26rem column.
   */
  const [mode, setMode] = useState<"edit" | "preview">("edit");

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so a click into a text
    // field inside a card is still a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  /**
   * Resolves what a drag ended over into a container and an index.
   *
   * dnd-kit reports the id it collided with, which is either a container
   * (`root`, `row:…:0`) or another item. An item means "put it next to this
   * one", so the container is that item's container and the index is its
   * position — computed against the tree *before* the move, which `moveItem`
   * accounts for by removing first and inserting second.
   */
  const resolveDrop = (
    tree: EditorNode[],
    overId: string,
    moving: string | null,
  ): { container: ContainerId; index: number } | null => {
    const asContainer = parseContainer(overId);
    if (asContainer)
      return {
        container: overId as ContainerId,
        index: itemsIn(tree, overId as ContainerId).length,
      };

    const over = locate(tree, overId);
    if (!over) return null;

    /*
     * A drop onto a block whose row is full becomes a drop *beside* that row.
     *
     * Every ordinary block lives in a row of one, and a row of one is full at
     * one block — so dropping anything onto a paragraph resolved to a
     * container that refused it, and the drag did nothing at all. What the
     * gesture means is "put it here", and here is the body, next to the row
     * the block is in.
     */
    const c = parseContainer(over.container);
    if (c?.kind === "column") {
      const row = tree.find((n) => n.id === c.rowId);
      const items = itemsIn(tree, over.container);
      const full = row?.type === "row" && items.length >= capacity(row);
      // Not full when the thing being dropped is already the occupant — that
      // is a reorder within the column, not a new arrival.
      if (full && !items.includes(moving ?? "")) {
        const at = tree.findIndex((n) => n.id === c.rowId);
        return { container: "root", index: at === -1 ? tree.length : at + 1 };
      }
    }
    return { container: over.container, index: over.index };
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;
    const activeId = String(e.active.id);

    onChange((tree) => {
      const drop = resolveDrop(tree, overId, activeId);
      if (!drop) return tree;

      // A palette drag creates a block rather than moving one.
      const fresh = parsePaletteId(activeId);
      if (fresh) {
        const node =
          fresh.kind === "leaf"
            ? editorLeaf(blockDefaults(fresh.leaf))
            : editorRow(fresh.layout);
        const next = insertNode(tree, drop.container, drop.index, node);
        // Select what was just dropped, so the inspector is already on it.
        if (next !== tree) queueMicrotask(() => setSelectedId(node.id));
        return next;
      }

      if (activeId === overId) return tree;
      return moveItem(tree, activeId, drop.container, drop.index);
    });
  };

  /** Click-to-add: appends to the root, or into the selected block's container. */
  /** The index in the body of the row the selection is in, or the end. */
  const rowIndexOf = (tree: EditorNode[], id: string | null): number => {
    if (!id) return tree.length;
    const found = locate(tree, id);
    if (!found) return tree.length;
    const c = parseContainer(found.container);
    const rowId = c?.kind === "column" ? c.rowId : found.node.id;
    const at = tree.findIndex((n) => n.id === rowId);
    return at === -1 ? tree.length : at + 1;
  };

  /**
   * Adds a block beside the selection, or after it.
   *
   * Into the selected block's own column when that column has room — which is
   * a row with real columns — and otherwise as a new row directly after the
   * one the selection is in. It used to insert into the selection's container
   * unconditionally, and a row of one is full at one block, so clicking a
   * palette tile while an ordinary block was selected did nothing at all.
   */
  const addLeaf = (kind: LeafKind) => {
    const node = editorLeaf(blockDefaults(kind));
    onChange((tree) => {
      const target = selectedId ? locate(tree, selectedId) : null;
      const c = target ? parseContainer(target.container) : null;
      if (c?.kind === "column") {
        const row = tree.find((n) => n.id === c.rowId);
        const items = itemsIn(tree, target!.container);
        if (row?.type === "row" && items.length < capacity(row))
          return insertNode(tree, target!.container, items.length, node);
      }
      return insertNode(tree, "root", rowIndexOf(tree, selectedId), node);
    });
    setSelectedId(node.id);
  };

  const addRow = (layout: ColumnLayout) => {
    const node = editorRow(layout);
    // After the row the selection is in, not at the very end: a block added
    // while you are looking at the middle of a body belongs where you are
    // looking. A row cannot nest, so the root is the only container for it.
    onChange((tree) =>
      insertNode(tree, "root", rowIndexOf(tree, selectedId), node),
    );
    setSelectedId(node.id);
  };

  /** Appends a layout's blocks, selecting the first so the eye lands on it. */
  const insertLayout = (blocks: CampaignBlock[]) => {
    const added = editorNodesOf(blocks);
    onChange((tree) => [...tree, ...added]);
    if (added[0]) setSelectedId(added[0].id);
  };

  const removeById = (id: string) => {
    onChange((tree) => removeNode(tree, id));
    setSelectedId((current) => (current === id ? null : current));
  };

  /**
   * The Edit/Preview switch, defined once and rendered into whichever card is
   * on screen. Hiding the card that holds it is how you build a preview mode
   * nobody can leave, and leaving an empty card behind just to keep the switch
   * is a card of nothing.
   */
  const modeToggle = (
    <SegmentedControl
      value={mode}
      options={[
        { value: "edit" as const, label: "Edit" },
        { value: "preview" as const, label: "Preview" },
      ]}
      onChange={(v) => {
        setMode(v);
        if (v === "preview") setSelectedId(null);
      }}
      aria-label="Canvas mode"
    />
  );

  const located = selectedId ? locate(nodes, selectedId) : null;
  const selectedNode = located?.node ?? null;
  /*
   * The row a selected block sits in, if any.
   *
   * A row is almost impossible to select by clicking: it is a container, and
   * every pixel of it that is not a few pixels of gutter belongs to a block
   * inside it. So the row's own settings — its layout, its gutter, its
   * vertical alignment — were unreachable in practice unless you happened to
   * hit the edge. The panel names the row above the block and lets you go up.
   */
  const container = located ? parseContainer(located.container) : null;
  const parentRow = container?.kind === "column" ? container.rowId : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={(e: DragStartEvent) => setDragging(String(e.active.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      {/* Clicking the background clears the selection, which is what makes the
          inspector feel like it belongs to the canvas. */}
      {/*
       * Two columns, not three.
       *
       * There was a preview panel *and* a preview mode, which is two answers
       * to the same question: the panel was a 26rem column showing a 680px
       * email, so the "desktop" preview was narrower than a phone and the
       * canvas it sat beside was squeezed to make room for it. One preview,
       * reached by the toggle, at the width a desktop client actually gives an
       * email.
       */}
      <div
        className={cn(
          "grid gap-6",
          mode === "edit" && "xl:grid-cols-[16rem_minmax(0,1fr)]",
        )}
        onClick={() => setSelectedId(null)}
      >
        {/*
         * Below the canvas until there is room for a column beside it.
         *
         * Stacked above, adding a block to the middle of a long body meant
         * dragging from the top of the page down past everything — and the
         * page scrolls, so the drag had to be paused at the edge to scroll.
         * Below it, the palette is next to the end of the body, which is where
         * blocks are usually added; the click-to-add path puts one beside
         * whatever is selected, which is the answer for the middle.
         */}
        <div
          className={cn(
            "order-2 flex flex-col gap-4 xl:order-none xl:sticky xl:top-6 xl:self-start",
            mode === "preview" && "hidden",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Card className="p-4">
            <Palette
              disabled={readOnly}
              onAddLeaf={addLeaf}
              onAddRow={addRow}
            />
          </Card>
          <Card className="p-4">
            <LayoutPicker
              disabled={readOnly}
              onInsert={insertLayout}
              onApplyTheme={onThemeChange}
              currentBlocks={blocksOfTree(nodes)}
              currentTheme={Object.keys(theme).length > 0 ? theme : null}
            />
          </Card>
          <Card className="p-4" role="region" aria-label="Block settings">
            {/*
             * The whole path, always — Body, then the row if there is one,
             * then the block.
             *
             * It only showed the row, so a block sitting straight in the body
             * had no crumb at all and no way back to the body's own settings
             * except knowing to click the canvas background. Every level that
             * has settings is now a step you can take.
             */}
            <nav
              aria-label="Selection"
              className="num-stamp mb-3 flex flex-wrap items-center gap-1.5"
            >
              <Crumb onClick={() => setSelectedId(null)}>Body</Crumb>
              {parentRow && (
                <>
                  <CrumbArrow />
                  <Crumb onClick={() => setSelectedId(parentRow)}>Row</Crumb>
                </>
              )}
              {selectedNode && (
                <>
                  <CrumbArrow />
                  <span>
                    {selectedNode.type === "row"
                      ? "Row"
                      : BLOCK_LABELS[selectedNode.block.kind]}
                  </span>
                </>
              )}
            </nav>
            {/* Nothing selected means the author is looking at the email, not
                at a paragraph — so the panel offers the email. */}
            {selectedNode === null ? (
              <ThemePanel
                theme={theme}
                readOnly={readOnly}
                onChange={onThemeChange}
              />
            ) : selectedNode.type === "row" ? (
              <RowInspector
                row={selectedNode}
                readOnly={readOnly}
                onChange={(patch) =>
                  onChange((tree) => updateRow(tree, selectedNode.id, patch))
                }
              />
            ) : (
              <LeafInspector
                block={selectedNode.block}
                readOnly={readOnly}
                onChange={(block) =>
                  onChange((tree) => replaceLeaf(tree, selectedNode.id, block))
                }
              />
            )}
          </Card>
        </div>

        <div
          className="order-1 flex min-w-0 flex-col gap-6 xl:order-none"
          onClick={(e) => e.stopPropagation()}
        >
          {settings}
          {/* The card stays in preview mode; only its canvas goes. The toggle
              lives in this header, and hiding the header is how you build a
              preview mode nobody can leave. */}
          <Card>
            <CardHeader>
              <CardTitle>{bodyTitle}</CardTitle>
              <div className="flex items-center gap-3">
                <span className="text-xs text-white/40">
                  {nodes.length} block{nodes.length === 1 ? "" : "s"}
                </span>
                {modeToggle}
              </div>
            </CardHeader>
            <CardBody
              className={cn(
                "flex flex-col gap-0 p-0",
                mode === "preview" && "hidden",
              )}
            >
              <Canvas
                nodes={nodes}
                theme={theme}
                readOnly={readOnly}
                selectedId={selectedId}
                invalidIndex={invalidIndex}
                onSelect={setSelectedId}
                onChangeLeaf={(id, block: LeafBlock) =>
                  onChange((tree) => replaceLeaf(tree, id, block))
                }
                onRemove={removeById}
              />
            </CardBody>
            {mode === "preview" && (
              <CardBody className="flex flex-col gap-3 p-0">{preview}</CardBody>
            )}
          </Card>
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {dragging && <DragChip id={dragging} nodes={nodes} />}
      </DragOverlay>
    </DndContext>
  );
}

/** What follows the cursor during a drag. */
function DragChip({ id, nodes }: { id: string; nodes: EditorNode[] }) {
  const fresh = parsePaletteId(id);
  const label = fresh
    ? fresh.kind === "leaf"
      ? BLOCK_LABELS[fresh.leaf]
      : `Columns ${fresh.layout}`
    : (() => {
        const found = locate(nodes, id);
        if (!found) return "Block";
        return found.node.type === "row"
          ? `Columns ${found.node.layout}`
          : BLOCK_LABELS[found.node.block.kind];
      })();
  return (
    <span className="glass-strong pointer-events-none inline-flex items-center gap-2 px-3 py-2 text-xs text-white shadow-glass">
      {label}
    </span>
  );
}

/** A step in the selection path: somewhere with settings, one click away. */
function Crumb({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="num-stamp text-white/45 underline-offset-2 transition-colors hover:text-white hover:underline"
    >
      {children}
    </button>
  );
}

function CrumbArrow() {
  return <IconChevronRight aria-hidden className="text-[10px] text-white/25" />;
}
