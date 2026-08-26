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
import {
  BLOCK_LABELS,
  blockDefaults,
  type LeafKind,
} from "@/lib/editor/blocks";
import {
  blocksOfTree,
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
import { Canvas, RootDropZone } from "./Canvas";
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
  /** The right-hand column. */
  preview: ReactNode;
  bodyTitle?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

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
  ): { container: ContainerId; index: number } | null => {
    if (parseContainer(overId)) {
      const container = overId as ContainerId;
      return { container, index: itemsIn(tree, container).length };
    }
    const over = locate(tree, overId);
    return over ? { container: over.container, index: over.index } : null;
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;
    const activeId = String(e.active.id);

    onChange((tree) => {
      const drop = resolveDrop(tree, overId);
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
  const addLeaf = (kind: LeafKind) => {
    const node = editorLeaf(blockDefaults(kind));
    onChange((tree) => {
      const target = selectedId ? locate(tree, selectedId) : null;
      const container: ContainerId = target?.container ?? "root";
      return insertNode(tree, container, itemsIn(tree, container).length, node);
    });
    setSelectedId(node.id);
  };

  const addRow = (layout: ColumnLayout) => {
    const node = editorRow(layout);
    // Always at the root: a row cannot nest, so "next to the selection" is
    // only meaningful when the selection is itself at the root.
    onChange((tree) => insertNode(tree, "root", tree.length, node));
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

  const selectedNode = selectedId
    ? (locate(nodes, selectedId)?.node ?? null)
    : null;

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
      <div
        className="grid gap-6 xl:grid-cols-[15rem_minmax(0,1fr)_minmax(0,26rem)]"
        onClick={() => setSelectedId(null)}
      >
        <div
          className="flex flex-col gap-4 xl:sticky xl:top-20 xl:self-start"
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
          <Card className="p-4">
            <p className="num-stamp mb-3">
              {selectedNode
                ? selectedNode.type === "row"
                  ? "Row style"
                  : `${BLOCK_LABELS[selectedNode.block.kind]} style`
                : "Body style"}
            </p>
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
          className="flex min-w-0 flex-col gap-6"
          onClick={(e) => e.stopPropagation()}
        >
          {settings}
          <Card>
            <CardHeader>
              <CardTitle>{bodyTitle}</CardTitle>
              <span className="text-xs text-white/40">
                {nodes.length} block{nodes.length === 1 ? "" : "s"}
              </span>
            </CardHeader>
            <CardBody className="flex flex-col gap-2.5">
              <Canvas
                nodes={nodes}
                readOnly={readOnly}
                selectedId={selectedId}
                invalidIndex={invalidIndex}
                onSelect={setSelectedId}
                onChangeLeaf={(id, block: LeafBlock) =>
                  onChange((tree) => replaceLeaf(tree, id, block))
                }
                onRemove={removeById}
              />
              {!readOnly && <RootDropZone empty={nodes.length === 0} />}
            </CardBody>
          </Card>
        </div>

        <div onClick={(e) => e.stopPropagation()}>{preview}</div>
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
