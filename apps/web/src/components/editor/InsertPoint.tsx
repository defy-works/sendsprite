"use client";
import { useState } from "react";
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
  /*
   * Lifted above the other insert points while the menu is open.
   *
   * Each of these is its own stacking context, so the menu's `z-50` is
   * resolved *inside* this one — and every insert point further down the body
   * comes later in the DOM at the same z-index, so they painted their buttons
   * over the open menu.
   */
  const [open, setOpen] = useState(false);
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
    <div
      className={cn("pointer-events-none relative h-0", open ? "z-40" : "z-10")}
    >
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
          onOpenChange={setOpen}
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
