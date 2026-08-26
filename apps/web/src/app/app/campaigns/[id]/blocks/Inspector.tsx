"use client";
import {
  COLUMN_LAYOUTS,
  IMAGE_WIDTHS,
  type ColumnLayout,
  type CornerStyle,
  type ImageWidth,
  type LeafBlock,
} from "@sendsprite/shared";
import { ColorField } from "@/components/ui/ColorField";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Toggle";
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
} from "@/components/ui/icons";
import { LAYOUT_LABELS } from "../../preview";
import type { EditorRow } from "../../tree";

/**
 * How the selected block looks.
 *
 * A panel rather than more fields on the card, for the reason a card with
 * eleven inputs is unusable: presentation is optional, most blocks never touch
 * it, and every control here would otherwise be on screen for every block in
 * the body at once. Selecting a block is what brings it up.
 *
 * Every control writes a value from a closed set — the enums the contract
 * declares — except the colour fields, which write `#rrggbb` or `undefined`.
 * `undefined` matters: it is "use the default", and it is why these are not
 * `<input type="color">`, which cannot express it.
 */

const ALIGN_OPTIONS = [
  { value: "left" as const, label: <IconAlignLeft />, title: "Left" },
  { value: "center" as const, label: <IconAlignCenter />, title: "Centre" },
  { value: "right" as const, label: <IconAlignRight />, title: "Right" },
];

const CORNER_OPTIONS = [
  { value: "sharp" as const, label: "Sharp" },
  { value: "soft" as const, label: "Soft" },
  { value: "pill" as const, label: "Pill" },
];

export function LeafInspector({
  block,
  readOnly,
  onChange,
}: {
  block: LeafBlock;
  readOnly: boolean;
  onChange: (block: LeafBlock) => void;
}) {
  switch (block.kind) {
    case "heading":
    case "text":
      return (
        <div className="flex flex-col gap-4">
          <SegmentedControl
            label="Alignment"
            value={block.align ?? "left"}
            options={ALIGN_OPTIONS}
            disabled={readOnly}
            onChange={(v) => onChange({ ...block, align: v })}
          />
          <ColorField
            label="Colour"
            value={block.color}
            fallback="#111111"
            disabled={readOnly}
            onChange={(color) => onChange({ ...block, color })}
          />
        </div>
      );

    case "button":
      return (
        <div className="flex flex-col gap-4">
          <SegmentedControl
            label="Alignment"
            value={block.align ?? "left"}
            options={ALIGN_OPTIONS}
            disabled={readOnly}
            onChange={(v) => onChange({ ...block, align: v })}
          />
          <SegmentedControl
            label="Corners"
            value={block.corners ?? "soft"}
            options={CORNER_OPTIONS}
            disabled={readOnly}
            onChange={(v: CornerStyle) => onChange({ ...block, corners: v })}
          />
          <ColorField
            label="Background"
            value={block.color}
            fallback="#4f46e5"
            disabled={readOnly}
            onChange={(color) => onChange({ ...block, color })}
          />
          <ColorField
            label="Label colour"
            value={block.textColor}
            fallback="#ffffff"
            disabled={readOnly}
            onChange={(textColor) => onChange({ ...block, textColor })}
          />
          <Switch
            checked={block.fullWidth === true}
            disabled={readOnly}
            onChange={(fullWidth) =>
              onChange({ ...block, fullWidth: fullWidth || undefined })
            }
            label="Full width"
            hint="Stretches to the column. Alignment stops applying."
          />
        </div>
      );

    case "image":
      return (
        <div className="flex flex-col gap-4">
          <SegmentedControl
            label="Alignment"
            value={block.align ?? "left"}
            options={ALIGN_OPTIONS}
            disabled={readOnly}
            onChange={(v) => onChange({ ...block, align: v })}
          />
          <SegmentedControl
            label="Width"
            value={String(block.width ?? 100)}
            options={IMAGE_WIDTHS.map((w) => ({
              value: String(w),
              label: `${w}%`,
            }))}
            disabled={readOnly}
            onChange={(v) =>
              onChange({ ...block, width: Number(v) as ImageWidth })
            }
          />
          <SegmentedControl
            label="Corners"
            value={block.corners ?? "sharp"}
            options={CORNER_OPTIONS}
            disabled={readOnly}
            onChange={(v: CornerStyle) => onChange({ ...block, corners: v })}
          />
        </div>
      );

    case "divider":
      return (
        <ColorField
          label="Colour"
          value={block.color}
          fallback="#e5e7eb"
          disabled={readOnly}
          onChange={(color) => onChange({ ...block, color })}
        />
      );

    case "spacer":
      return (
        <p className="text-sm text-white/55">
          A spacer has no styling — its height is its content, and it is under
          Content.
        </p>
      );
  }
}

export function RowInspector({
  row,
  readOnly,
  onChange,
}: {
  row: EditorRow;
  readOnly: boolean;
  onChange: (patch: {
    layout?: ColumnLayout;
    background?: string | undefined;
  }) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl
        label="Layout"
        value={row.layout}
        options={COLUMN_LAYOUTS.map((l) => ({
          value: l,
          label: <LayoutGlyph layout={l} />,
          title: LAYOUT_LABELS[l],
        }))}
        disabled={readOnly}
        onChange={(layout) => onChange({ layout })}
      />
      <p className="text-xs text-white/50">
        {LAYOUT_LABELS[row.layout]}. Columns stack on a phone in every client
        that supports media queries; Outlook on Windows keeps them side by side,
        which is the readable fallback.
      </p>
      <ColorField
        label="Row background"
        value={row.background}
        fallback="#ffffff"
        disabled={readOnly}
        onChange={(background) => onChange({ background })}
      />
    </div>
  );
}

/** The ratio, drawn. Three words in a segmented control is three ellipses. */
function LayoutGlyph({ layout }: { layout: ColumnLayout }) {
  const parts =
    layout === "1-1"
      ? [1, 1]
      : layout === "1-1-1"
        ? [1, 1, 1]
        : layout === "2-1"
          ? [2, 1]
          : [1, 2];
  return (
    <span aria-hidden className="flex h-3 w-8 items-stretch gap-[2px]">
      {parts.map((p, i) => (
        <span
          key={i}
          style={{ flexGrow: p }}
          className="rounded-[1px] bg-current opacity-70"
        />
      ))}
    </span>
  );
}
