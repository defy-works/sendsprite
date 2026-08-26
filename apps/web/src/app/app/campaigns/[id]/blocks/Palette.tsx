"use client";
import { useDraggable } from "@dnd-kit/core";
import type { ReactNode } from "react";
import { COLUMN_LAYOUTS, type ColumnLayout } from "@sendsprite/shared";
import {
  IconButtonBlock,
  IconColumns,
  IconDivider,
  IconHeading,
  IconImage,
  IconSpacer,
  IconText,
} from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { BLOCK_KINDS, BLOCK_LABELS, LAYOUT_LABELS } from "../../preview";
import type { LeafKind } from "../../preview";

/**
 * The block palette.
 *
 * Every tile is both draggable and clickable, on purpose. Drag is what the
 * feature is for — dropping a button into the right-hand column of a row is
 * not expressible any other way — but drag is also the interaction that fails
 * on a touchpad, in a screen reader, and for anyone who just wants another
 * paragraph at the end. Click appends; drag places.
 *
 * The drag id is prefixed `new:` so the canvas can tell a palette drag from a
 * block being moved: one inserts, the other relocates, and they arrive through
 * the same dnd-kit events.
 */

export const NEW_PREFIX = "new:";

/** `new:leaf:heading` or `new:row:1-1`. Parsed by the canvas. */
export type PaletteId = `${typeof NEW_PREFIX}${string}`;

export const paletteLeafId = (kind: LeafKind): PaletteId =>
  `${NEW_PREFIX}leaf:${kind}`;
export const paletteRowId = (layout: ColumnLayout): PaletteId =>
  `${NEW_PREFIX}row:${layout}`;

export function parsePaletteId(
  id: string,
):
  | { kind: "leaf"; leaf: LeafKind }
  | { kind: "row"; layout: ColumnLayout }
  | null {
  if (!id.startsWith(NEW_PREFIX)) return null;
  const rest = id.slice(NEW_PREFIX.length);
  if (rest.startsWith("leaf:")) {
    const leaf = rest.slice(5);
    return (BLOCK_KINDS as readonly string[]).includes(leaf)
      ? { kind: "leaf", leaf: leaf as LeafKind }
      : null;
  }
  if (rest.startsWith("row:")) {
    const layout = rest.slice(4);
    return (COLUMN_LAYOUTS as readonly string[]).includes(layout)
      ? { kind: "row", layout: layout as ColumnLayout }
      : null;
  }
  return null;
}

const LEAF_ICON: Record<LeafKind, ReactNode> = {
  heading: <IconHeading />,
  text: <IconText />,
  button: <IconButtonBlock />,
  image: <IconImage />,
  divider: <IconDivider />,
  spacer: <IconSpacer />,
};

export function Palette({
  disabled,
  onAddLeaf,
  onAddRow,
}: {
  disabled: boolean;
  onAddLeaf: (kind: LeafKind) => void;
  onAddRow: (layout: ColumnLayout) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="num-stamp">Blocks</p>
        <div className="grid grid-cols-2 gap-1.5">
          {BLOCK_KINDS.map((kind) => (
            <Tile
              key={kind}
              id={paletteLeafId(kind)}
              disabled={disabled}
              icon={LEAF_ICON[kind]}
              label={BLOCK_LABELS[kind]}
              onClick={() => onAddLeaf(kind)}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <p className="num-stamp">Layout</p>
        <div className="grid grid-cols-2 gap-1.5">
          {COLUMN_LAYOUTS.map((layout) => (
            <Tile
              key={layout}
              id={paletteRowId(layout)}
              disabled={disabled}
              icon={<IconColumns />}
              label={LAYOUT_LABELS[layout]}
              onClick={() => onAddRow(layout)}
            />
          ))}
        </div>
      </div>
      <p className="text-xs text-white/45">
        Click to add at the end, or drag onto the canvas to place it — including
        inside a column.
      </p>
    </div>
  );
}

function Tile({
  id,
  icon,
  label,
  disabled,
  onClick,
}: {
  id: string;
  icon: ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    disabled,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={`Add ${label}`}
      className={cn(
        "flex cursor-grab flex-col items-center gap-1.5 rounded-md border border-white/10 bg-white/4 px-2 py-3",
        "text-[11px] text-white/70 transition-colors duration-[var(--duration-fast)]",
        "hover:border-indigo-400/50 hover:bg-indigo-500/10 hover:text-white",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:bg-white/4",
        isDragging && "opacity-40",
      )}
      {...attributes}
      {...listeners}
    >
      <span className="text-base text-indigo-300/80">{icon}</span>
      <span className="text-center leading-tight">{label}</span>
    </button>
  );
}
