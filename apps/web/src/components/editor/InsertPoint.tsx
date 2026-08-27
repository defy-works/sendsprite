"use client";
import { COLUMN_LAYOUTS, type ColumnLayout } from "@sendsprite/shared";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { IconColumns, IconPlus } from "@/components/ui/icons";
import {
  BLOCK_KINDS,
  BLOCK_LABELS,
  LAYOUT_LABELS,
  type LeafKind,
} from "@/lib/editor/blocks";
import { cn } from "@/lib/cn";

/**
 * The gap between two blocks, as somewhere to add one.
 *
 * Every editor of this shape has this and it is the reason they feel direct:
 * the answer to "how do I put a button under this paragraph" should be visible
 * at the place the button is going, not in a palette at the other side of the
 * screen that appends to the end and leaves you to drag it back.
 *
 * Invisible until the gap is hovered — a canvas with a permanent row of plus
 * buttons down the middle is a form again — and always present at the very
 * end, where an empty body needs somewhere to start.
 */
export function InsertPoint({
  index,
  onAddLeaf,
  onAddRow,
  always = false,
  label = "Add a block here",
}: {
  /** Where in the container a new block lands. */
  index: number;
  onAddLeaf: (kind: LeafKind, index: number) => void;
  onAddRow: (layout: ColumnLayout, index: number) => void;
  /** Keep it visible: for the one at the end of an empty body. */
  always?: boolean;
  label?: string;
}) {
  return (
    /*
     * Zero height and no pointer events of its own.
     *
     * A strip between two blocks that accepts a click is a strip that eats the
     * clicks meant for them: at 24px tall and centred it overlapped the
     * paragraph above and below by half its height each, and selecting that
     * paragraph became impossible. Only the button takes the pointer, and it
     * sits in the gutter beside the card rather than over the content — which
     * is where every editor of this shape puts it, for this reason.
     */
    <div className="pointer-events-none relative z-10 h-0">
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-0 top-0 h-px bg-indigo-500 transition-opacity",
          always ? "opacity-15" : "opacity-0",
        )}
      />
      <div className="pointer-events-auto absolute top-0 -left-3 -translate-x-full -translate-y-1/2">
        <Menu
          label={label}
          align="start"
          trigger={({ open }) => (
            <span
              title={label}
              className={cn(
                "grid h-6 w-6 place-items-center rounded-full border border-indigo-500/60 bg-white text-indigo-600 shadow-sm transition-opacity",
                open ? "opacity-100" : "opacity-45 hover:opacity-100",
              )}
            >
              <IconPlus className="text-sm" />
            </span>
          )}
        >
          <MenuLabel>Block</MenuLabel>
          {BLOCK_KINDS.map((kind) => (
            <MenuItem key={kind} onSelect={() => onAddLeaf(kind, index)}>
              {BLOCK_LABELS[kind]}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuLabel>Columns</MenuLabel>
          {COLUMN_LAYOUTS.map((layout) => (
            <MenuItem
              key={layout}
              icon={<IconColumns />}
              onSelect={() => onAddRow(layout, index)}
            >
              {LAYOUT_LABELS[layout]}
            </MenuItem>
          ))}
        </Menu>
      </div>
    </div>
  );
}
