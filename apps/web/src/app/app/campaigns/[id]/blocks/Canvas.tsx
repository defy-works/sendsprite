"use client";
import { useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { LeafBlock } from "@sendsprite/shared";
import { Button } from "@/components/ui/Button";
import { IconColumns, IconGrip, IconTrash } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { BLOCK_LABELS, blockIssue } from "../../preview";
import {
  columnContainer,
  type EditorLeaf,
  type EditorNode,
  type EditorRow,
} from "../../tree";
import { BlockFields } from "./BlockFields";

/**
 * The canvas: the body as a stack of cards, with rows drawn as side-by-side
 * drop zones.
 *
 * Two sortable levels, and dnd-kit needs both to be explicit. The root is one
 * `SortableContext` over node ids; each column is another over its leaf ids;
 * and each column is also a `useDroppable`, because an empty column has no
 * sortable items and would otherwise be invisible to a drag.
 *
 * The whole card is not the drag handle. A card full of inputs that starts a
 * drag on `mousedown` is a card whose text cannot be selected, which is worse
 * than an extra six pixels of grip.
 */

export function Canvas({
  nodes,
  readOnly,
  selectedId,
  invalidIndex,
  onSelect,
  onChangeLeaf,
  onRemove,
}: {
  nodes: EditorNode[];
  readOnly: boolean;
  selectedId: string | null;
  /** Index in `nodes` the preview blamed, which is the louder signal. */
  invalidIndex: number | null;
  onSelect: (id: string | null) => void;
  onChangeLeaf: (id: string, block: LeafBlock) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <SortableContext
      items={nodes.map((n) => n.id)}
      strategy={verticalListSortingStrategy}
    >
      <ul className="flex list-none flex-col gap-2.5">
        {nodes.map((node, i) =>
          node.type === "row" ? (
            <RowCard
              key={node.id}
              row={node}
              readOnly={readOnly}
              selectedId={selectedId}
              invalid={invalidIndex === i}
              onSelect={onSelect}
              onChangeLeaf={onChangeLeaf}
              onRemove={onRemove}
            />
          ) : (
            <LeafCard
              key={node.id}
              leaf={node}
              readOnly={readOnly}
              selected={selectedId === node.id}
              invalid={invalidIndex === i}
              onSelect={onSelect}
              onChange={onChangeLeaf}
              onRemove={onRemove}
            />
          ),
        )}
      </ul>
    </SortableContext>
  );
}

function LeafCard({
  leaf,
  readOnly,
  selected,
  invalid,
  compact = false,
  onSelect,
  onChange,
  onRemove,
}: {
  leaf: EditorLeaf;
  readOnly: boolean;
  selected: boolean;
  invalid: boolean;
  /** Inside a column: tighter padding, no numbering. */
  compact?: boolean;
  onSelect: (id: string | null) => void;
  onChange: (id: string, block: LeafBlock) => void;
  onRemove: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: leaf.id, disabled: readOnly });
  const issue = blockIssue(leaf.block);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // Selecting on focus as well as click: tabbing into a field inside a
      // block should bring up that block's style panel, or the panel and the
      // canvas disagree about what is being edited.
      onFocusCapture={() => onSelect(leaf.id)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(leaf.id);
      }}
      className={cn(
        "flex cursor-default flex-col gap-2.5 rounded-lg border bg-shadow/60 transition-colors",
        compact ? "p-2.5" : "p-3.5",
        isDragging && "z-10 opacity-70",
        issue || invalid
          ? "border-amber-400/45"
          : selected
            ? "border-indigo-400/70 shadow-[0_0_0_1px_var(--color-indigo-500)]"
            : "border-white/10 hover:border-white/25",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {!readOnly && (
            <button
              type="button"
              className="cursor-grab rounded p-1 text-white/35 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
              aria-label={`Move ${BLOCK_LABELS[leaf.block.kind]} block`}
              onClick={(e) => e.stopPropagation()}
              {...attributes}
              {...listeners}
            >
              <IconGrip className="text-sm" />
            </button>
          )}
          <span className="num-stamp truncate">
            {BLOCK_LABELS[leaf.block.kind]}
          </span>
        </div>
        {!readOnly && (
          <Button
            size="iconSm"
            variant="ghost"
            aria-label={`Remove ${BLOCK_LABELS[leaf.block.kind]} block`}
            className="text-white/35 hover:bg-red-500/12 hover:text-red-300"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(leaf.id);
            }}
          >
            <IconTrash />
          </Button>
        )}
      </div>

      <BlockFields
        block={leaf.block}
        readOnly={readOnly}
        id={leaf.id}
        onChange={(block) => onChange(leaf.id, block)}
      />

      {issue && (
        <p role="alert" className="text-xs text-amber-300">
          {issue}
        </p>
      )}
    </li>
  );
}

function RowCard({
  row,
  readOnly,
  selectedId,
  invalid,
  onSelect,
  onChangeLeaf,
  onRemove,
}: {
  row: EditorRow;
  readOnly: boolean;
  selectedId: string | null;
  invalid: boolean;
  onSelect: (id: string | null) => void;
  onChangeLeaf: (id: string, block: LeafBlock) => void;
  onRemove: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.id, disabled: readOnly });
  const selected = selectedId === row.id;

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // The row background is shown on the canvas, faintly: at full
        // strength a white row background would black out the dark cards
        // sitting on it, and the point is to see that a background is set.
        ...(row.background
          ? {
              backgroundColor: `color-mix(in srgb, ${row.background} 14%, transparent)`,
            }
          : null),
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(row.id);
      }}
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-2.5 transition-colors",
        isDragging && "z-10 opacity-70",
        invalid
          ? "border-amber-400/45"
          : selected
            ? "border-indigo-400/70 shadow-[0_0_0_1px_var(--color-indigo-500)]"
            : "border-white/10 hover:border-white/25",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {!readOnly && (
            <button
              type="button"
              className="cursor-grab rounded p-1 text-white/35 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
              aria-label="Move row"
              onClick={(e) => e.stopPropagation()}
              {...attributes}
              {...listeners}
            >
              <IconGrip className="text-sm" />
            </button>
          )}
          <span className="num-stamp flex items-center gap-1.5">
            <IconColumns className="text-sm" />
            {row.layout}
          </span>
          {row.background && (
            <span
              aria-label={`Row background ${row.background}`}
              className="h-3 w-3 rounded-full border border-white/25"
              style={{ background: row.background }}
            />
          )}
        </div>
        {!readOnly && (
          <Button
            size="iconSm"
            variant="ghost"
            aria-label="Remove row"
            className="text-white/35 hover:bg-red-500/12 hover:text-red-300"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(row.id);
            }}
          >
            <IconTrash />
          </Button>
        )}
      </div>

      <div className="flex gap-2">
        {row.columns.map((column, i) => (
          <Column
            key={i}
            rowId={row.id}
            index={i}
            grow={growOf(row.layout, i)}
            leaves={column}
            readOnly={readOnly}
            selectedId={selectedId}
            onSelect={onSelect}
            onChangeLeaf={onChangeLeaf}
            onRemove={onRemove}
          />
        ))}
      </div>
    </li>
  );
}

/** The canvas mirrors the rendered ratio, so the editor looks like the email. */
function growOf(layout: EditorRow["layout"], index: number): number {
  if (layout === "2-1") return index === 0 ? 2 : 1;
  if (layout === "1-2") return index === 0 ? 1 : 2;
  return 1;
}

function Column({
  rowId,
  index,
  grow,
  leaves,
  readOnly,
  selectedId,
  onSelect,
  onChangeLeaf,
  onRemove,
}: {
  rowId: string;
  index: number;
  grow: number;
  leaves: EditorLeaf[];
  readOnly: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChangeLeaf: (id: string, block: LeafBlock) => void;
  onRemove: (id: string) => void;
}) {
  const id = columnContainer(rowId, index);
  // A droppable as well as a sortable context: an empty column contains no
  // sortable items, and without this there would be nothing for a drag to
  // detect a collision against — so a column could never receive its first
  // block.
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <SortableContext
      id={id}
      items={leaves.map((l) => l.id)}
      strategy={verticalListSortingStrategy}
    >
      <div
        ref={setNodeRef}
        style={{ flexGrow: grow, flexBasis: 0 }}
        className={cn(
          "flex min-h-24 min-w-0 flex-col gap-2 rounded-md border border-dashed p-2 transition-colors",
          isOver
            ? "border-indigo-400/70 bg-indigo-500/8"
            : "border-white/12 bg-white/2",
        )}
      >
        {leaves.length === 0 ? (
          <p className="m-auto px-1 text-center text-[11px] text-white/35">
            Drop a block here
          </p>
        ) : (
          <ul className="flex list-none flex-col gap-2">
            {leaves.map((leaf) => (
              <LeafCard
                key={leaf.id}
                leaf={leaf}
                compact
                readOnly={readOnly}
                selected={selectedId === leaf.id}
                invalid={false}
                onSelect={onSelect}
                onChange={onChangeLeaf}
                onRemove={onRemove}
              />
            ))}
          </ul>
        )}
      </div>
    </SortableContext>
  );
}

/** The root drop zone, so a body with no blocks can still receive one. */
export function RootDropZone({ empty }: { empty: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: "root" });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex items-center justify-center rounded-lg border border-dashed px-4 text-center text-xs transition-colors",
        empty ? "min-h-32 py-8" : "min-h-10 py-2",
        isOver
          ? "border-indigo-400/70 bg-indigo-500/8 text-indigo-200"
          : "border-white/12 text-white/35",
      )}
    >
      {empty
        ? "Nothing in the body yet — click a block on the left, or drag one here."
        : "Drop here to add at the end"}
    </div>
  );
}
