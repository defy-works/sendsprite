"use client";
import {
  useDndContext,
  useDroppable,
  type DraggableAttributes,
} from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import { useSortable } from "@dnd-kit/sortable";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  FONT_STACKS,
  renderBlockFragment,
  type CampaignTheme,
  type ColumnLayout,
  type LeafBlock,
} from "@sendsprite/shared";
import { Fragment, useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { IconColumns, IconGrip, IconTrash } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { BLOCK_LABELS, blockIssue } from "@/lib/editor/blocks";
import type { LeafKind } from "@/lib/editor/blocks";
import {
  columnContainer,
  type EditorLeaf,
  type EditorNode,
  type EditorRow,
} from "@/lib/editor/tree";
import { InlineEditor } from "./InlineEditor";
import { InsertPoint } from "./InsertPoint";

/**
 * The canvas: the email itself, with the editing chrome laid over it.
 *
 * It used to be a stack of dark cards, each a labelled form — a heading block
 * was a `Size` select and a `Text` input, not a heading. Everything about the
 * body that matters visually (how big the type is, how much room a block takes,
 * whether the two columns balance) was invisible until the eye moved to the
 * preview panel and back, which is the loop this removes.
 *
 * **The blocks are rendered by the same code that sends them.** Each one is
 * `renderBlockFragment` from `@sendsprite/shared`, the function the send and
 * the preview already go through, mounted per block so there is a DOM node to
 * hang selection, dragging and a toolbar on. A second renderer written in React
 * would be a second answer to "what does this look like", and the author would
 * be editing the one that is not sent.
 *
 * Two consequences worth knowing:
 *
 * - The markup carries its own inline styles, so it is largely immune to the
 *   dashboard's stylesheet — but not entirely. The frame in the preview panel
 *   stays the authority; this is a faithful working surface, not a proof.
 * - Text blocks are the exception: they mount the inline editor instead, since
 *   a paragraph you cannot type into is not what a canvas is for.
 */

export function Canvas({
  nodes,
  theme,
  readOnly,
  selectedId,
  invalidIndex,
  onSelect,
  onChangeLeaf,
  onRemove,
  onInsertLeaf,
  onInsertRow,
}: {
  nodes: EditorNode[];
  /** What the page looks like, so the canvas looks like it too. */
  theme: CampaignTheme;
  readOnly: boolean;
  selectedId: string | null;
  /** Index in `nodes` the preview blamed, which is the louder signal. */
  invalidIndex: number | null;
  onSelect: (id: string | null) => void;
  onChangeLeaf: (id: string, block: LeafBlock) => void;
  onRemove: (id: string) => void;
  /** Adds a block at a position in the body, from the gap it was asked for. */
  onInsertLeaf: (kind: LeafKind, index: number) => void;
  onInsertRow: (layout: ColumnLayout, index: number) => void;
}) {
  const pad = theme.contentPadding ?? 24;
  return (
    <div
      className="ss-canvas flex justify-center overflow-x-auto rounded-lg p-4"
      style={{ background: theme.pageBackground ?? "#f3f4f6" }}
    >
      <div
        className="w-full"
        style={{
          maxWidth: theme.contentWidth ?? 600,
          background: theme.cardBackground ?? "#ffffff",
          borderRadius:
            theme.cardCorners === "sharp"
              ? 0
              : theme.cardCorners === "pill"
                ? 24
                : 6,
        }}
      >
        <SortableContext
          items={nodes.map((n) => n.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul aria-label="Email body" className="flex list-none flex-col">
            {nodes.map((node, i) => (
              <Fragment key={node.id}>
                {!readOnly && (
                  <li aria-hidden className="list-none">
                    <InsertPoint
                      index={i}
                      onAddLeaf={onInsertLeaf}
                      onAddRow={onInsertRow}
                    />
                  </li>
                )}
                {node.type === "row" ? (
                  <RowShell
                    row={node}
                    theme={theme}
                    pad={pad}
                    readOnly={readOnly}
                    selectedId={selectedId}
                    invalid={invalidIndex === i}
                    onSelect={onSelect}
                    onChangeLeaf={onChangeLeaf}
                    onRemove={onRemove}
                  />
                ) : (
                  <LeafShell
                    leaf={node}
                    theme={theme}
                    pad={pad}
                    readOnly={readOnly}
                    selected={selectedId === node.id}
                    invalid={invalidIndex === i}
                    onSelect={onSelect}
                    onChange={onChangeLeaf}
                    onRemove={onRemove}
                  />
                )}
              </Fragment>
            ))}
          </ul>
        </SortableContext>
        {!readOnly && (
          <Tail
            empty={nodes.length === 0}
            index={nodes.length}
            pad={pad}
            onInsertLeaf={onInsertLeaf}
            onInsertRow={onInsertRow}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The end of the body: somewhere to drop, and somewhere to add.
 *
 * Inside the card rather than beneath it. As a sibling it drew its own page
 * background and its own white card, so a body with three blocks looked like
 * two documents with a gap between them.
 */
function Tail({
  empty,
  index,
  pad,
  onInsertLeaf,
  onInsertRow,
}: {
  empty: boolean;
  index: number;
  pad: number;
  onInsertLeaf: (kind: LeafKind, index: number) => void;
  onInsertRow: (layout: ColumnLayout, index: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "root" });
  // Only while something is being dragged, or while there is nothing to drop
  // onto. A permanent dashed box under every body is a second way to add a
  // block sitting directly beneath the first one.
  const dragging = useDndContext().active !== null;
  return (
    <div style={{ paddingLeft: pad, paddingRight: pad, paddingBottom: pad }}>
      <InsertPoint
        always
        index={index}
        label="Add a block at the end"
        onAddLeaf={onInsertLeaf}
        onAddRow={onInsertRow}
      />
      <div
        ref={setNodeRef}
        className={cn(
          "mt-2 flex items-center justify-center rounded border-dashed px-4 text-center text-xs transition-colors",
          empty || dragging ? "border" : "border-0",
          empty ? "min-h-32 py-8" : dragging ? "min-h-10 py-2" : "min-h-0",
          isOver
            ? "border-indigo-500 bg-indigo-500/10 text-indigo-700"
            : "border-black/15 text-black/40",
        )}
      >
        {empty
          ? "Nothing here yet — add a block, or drag one onto the page."
          : dragging
            ? "Drop here to add at the end"
            : null}
      </div>
    </div>
  );
}

/**
 * One toolbar per selected block, above it, in the dashboard's dark surface.
 *
 * It was two: a dark grip-and-bin floating over the block's top-right corner,
 * and — for a text block — a white formatting chip above its left. Two bars in
 * two colour schemes for one selection, and the dark one covered the words it
 * was attached to.
 *
 * Now it sits above the block, so the block stays readable, and a text block's
 * B / I / link controls join the same bar rather than bringing their own. The
 * `popover` surface is the one every other floating thing in the dashboard
 * uses, which is why it is not a bespoke white chip.
 */
function ChromeBar({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute -top-4 left-0 z-30 hidden [[data-selected='true']_>_&]:flex">
      <div className="popover pointer-events-auto flex items-center gap-0.5 px-1 py-0.5 shadow-glass">
        {children}
      </div>
    </div>
  );
}

/** The grip and the bin, without the bar around them. */
function ChromeButtons({
  label,
  attributes,
  listeners,
  onRemove,
  children,
}: {
  label: string;
  attributes: DraggableAttributes;
  listeners: SyntheticListenerMap | undefined;
  onRemove: () => void;
  children?: ReactNode;
}) {
  return (
    <>
      {children}
      <button
        type="button"
        className="cursor-grab rounded p-1 text-white/45 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
        aria-label={`Move ${label}`}
        onClick={(e) => e.stopPropagation()}
        {...attributes}
        {...listeners}
      >
        <IconGrip className="text-sm" />
      </button>
      <Button
        size="iconSm"
        variant="ghost"
        aria-label={`Remove ${label}`}
        className="text-white/45 hover:bg-red-500/15 hover:text-red-300"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        <IconTrash />
      </Button>
    </>
  );
}

/** The outline states, shared by leaves and rows. */
const outline = (selected: boolean, invalid: boolean, dragging: boolean) =>
  cn(
    "group/block relative cursor-default outline-offset-[-1px] transition-[outline-color]",
    dragging && "z-10 opacity-60",
    invalid
      ? "outline outline-2 outline-amber-400/70"
      : selected
        ? "outline outline-2 outline-indigo-500"
        : "outline outline-1 outline-transparent hover:outline-indigo-400/40",
  );

function LeafShell({
  leaf,
  theme,
  pad,
  width,
  readOnly,
  selected,
  invalid,
  onSelect,
  onChange,
  onRemove,
}: {
  leaf: EditorLeaf;
  theme: CampaignTheme;
  /** Horizontal gutter to draw the block inside, matching the card's. */
  pad: number;
  /** Layout width, for a block inside a column. */
  width?: number;
  readOnly: boolean;
  selected: boolean;
  invalid: boolean;
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
  const block = leaf.block;

  // Recomputed only when the block or the theme moves, because this is a full
  // render of the block's markup on every keystroke otherwise.
  const html = useMemo(
    () => renderBlockFragment(block, { theme, ...(width ? { width } : {}) }),
    [block, theme, width],
  );

  return (
    <li
      ref={setNodeRef}
      data-selected={selected}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        paddingLeft: pad,
        paddingRight: pad,
      }}
      onFocusCapture={() => onSelect(leaf.id)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(leaf.id);
      }}
      className={outline(selected, Boolean(issue) || invalid, isDragging)}
    >
      {/* A text block's own bar carries the formatting controls too, so a
          selected paragraph has one toolbar rather than two. */}
      {!readOnly && block.kind !== "text" && (
        <ChromeBar>
          <ChromeButtons
            label={`${BLOCK_LABELS[block.kind]} block`}
            attributes={attributes}
            listeners={listeners}
            onRemove={() => onRemove(leaf.id)}
          />
        </ChromeBar>
      )}

      {block.kind === "text" ? (
        /*
         * The one block edited where it lives, dressed as the paragraph it
         * will be sent as: the renderer's own font, size, colour and
         * alignment, so what is typed is what is read. Without them the
         * editor inherited the dashboard's white text onto a white card.
         */
        <div
          className="group/text relative"
          style={{
            paddingTop: block.spaceTop ?? 0,
            paddingBottom: block.spaceBottom ?? 0,
            fontFamily: FONT_STACKS[theme.font ?? "sans"],
            fontSize: 16,
            lineHeight: 1.6,
            color: block.color ?? theme.textColor ?? "#111111",
            textAlign: block.align ?? "left",
            margin: "0 0 16px",
          }}
        >
          <InlineEditor
            surface="canvas"
            value={block.html}
            readOnly={readOnly}
            label="Text block"
            onChange={(next) => onChange(leaf.id, { ...block, html: next })}
            toolbarOpen={selected}
            toolbarExtras={
              readOnly ? null : (
                <>
                  <span aria-hidden className="mx-1 h-4 w-px bg-white/15" />
                  <ChromeButtons
                    label="Text block"
                    attributes={attributes}
                    listeners={listeners}
                    onRemove={() => onRemove(leaf.id)}
                  />
                </>
              )
            }
          />
        </div>
      ) : (
        // Inert. The markup is real — a button block is a real anchor — and a
        // real anchor in an editing canvas is a click that leaves the page you
        // are editing. `pointer-events` off makes the whole block one target,
        // which is what selecting it should be.
        <div
          className="pointer-events-none select-none"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}

      {issue && (
        <p
          role="alert"
          className="rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-800"
        >
          {issue}
        </p>
      )}
    </li>
  );
}

function RowShell({
  row,
  theme,
  pad,
  readOnly,
  selectedId,
  invalid,
  onSelect,
  onChangeLeaf,
  onRemove,
}: {
  row: EditorRow;
  theme: CampaignTheme;
  pad: number;
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
  const gap = row.gap ?? 16;

  return (
    <li
      ref={setNodeRef}
      data-selected={selected}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        paddingLeft: pad,
        paddingRight: pad,
        paddingTop: row.spaceTop ?? 0,
        paddingBottom: row.spaceBottom ?? 0,
        ...(row.background ? { background: row.background } : null),
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(row.id);
      }}
      className={outline(selected, invalid, isDragging)}
    >
      {!readOnly && (
        <ChromeBar>
          <ChromeButtons
            label="row"
            attributes={attributes}
            listeners={listeners}
            onRemove={() => onRemove(row.id)}
          >
            <span className="flex items-center gap-1 px-1 text-[10px] text-white/45">
              <IconColumns className="text-sm" />
              {row.layout}
            </span>
          </ChromeButtons>
        </ChromeBar>
      )}

      <div className="flex" style={{ gap }}>
        {row.columns.map((column, i) => (
          <Column
            key={i}
            rowId={row.id}
            index={i}
            grow={growOf(row.layout, i)}
            leaves={column}
            theme={theme}
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
  theme,
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
  theme: CampaignTheme;
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
          "min-w-0 transition-colors",
          leaves.length === 0 && "min-h-16 rounded border border-dashed",
          isOver
            ? "border-indigo-500 bg-indigo-500/10"
            : leaves.length === 0 && "border-black/15",
        )}
      >
        {leaves.length === 0 ? (
          <p className="flex h-16 items-center justify-center px-1 text-center text-[11px] text-black/35">
            Drop a block here
          </p>
        ) : (
          <ul className="flex list-none flex-col">
            {leaves.map((leaf) => (
              <LeafShell
                key={leaf.id}
                leaf={leaf}
                theme={theme}
                pad={0}
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
