"use client";
import {
  BUTTON_SIZES,
  COLUMN_LAYOUTS,
  DIVIDER_STYLES,
  IMAGE_WIDTHS,
  VERTICAL_ALIGNMENTS,
  type ColumnLayout,
  type CornerStyle,
  type DividerStyle,
  type ImageWidth,
  type LeafBlock,
  type VerticalAlign,
} from "@sendsprite/shared";
import { ColorField } from "@/components/ui/ColorField";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { BlockFields } from "./BlockFields";
import { SpaceField, SpacingFields } from "./SpacingFields";
import { Switch } from "@/components/ui/Toggle";
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
} from "@/components/ui/icons";
import { LAYOUT_LABELS } from "@/lib/editor/blocks";
import type { EditorRow } from "@/lib/editor/tree";

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
  return (
    <div className="flex flex-col gap-5">
      {/* Content first, then style.
       *
       * These fields used to live on the block's card in the canvas. The canvas
       * draws the block itself now, so there is nowhere on it for a labelled
       * URL field to go — and a canvas that shows the email is worth more than
       * one that shows a form. Text is the exception and is absent here: it is
       * typed where it sits.
       */}
      {block.kind !== "text" && (
        <BlockFields
          block={block}
          readOnly={readOnly}
          id={`inspector-${block.kind}`}
          onChange={onChange}
        />
      )}
      <LeafStyle block={block} readOnly={readOnly} onChange={onChange} />
      {/* Every kind but the spacer, which is space already. Appended here
          rather than repeated in six branches: the pair is the same for all of
          them, and the only thing that varies is what sits above it. */}
      {block.kind !== "spacer" && (
        <SpacingFields
          kind={block.kind}
          spaceTop={block.spaceTop}
          spaceBottom={block.spaceBottom}
          disabled={readOnly}
          onChange={(patch) => onChange({ ...block, ...patch })}
        />
      )}
    </div>
  );
}

function LeafStyle({
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
            label="Size"
            value={block.size ?? "medium"}
            options={BUTTON_SIZES.map((v) => ({
              value: v,
              label: v === "small" ? "S" : v === "medium" ? "M" : "L",
              title: v[0]!.toUpperCase() + v.slice(1),
            }))}
            disabled={readOnly}
            onChange={(size) => onChange({ ...block, size })}
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
        <div className="flex flex-col gap-4">
          <ColorField
            label="Colour"
            value={block.color}
            fallback="#e5e7eb"
            disabled={readOnly}
            onChange={(color) => onChange({ ...block, color })}
          />
          <SegmentedControl
            label="Line"
            value={block.lineStyle ?? "solid"}
            options={DIVIDER_STYLES.map((v) => ({
              value: v,
              label: <RuleGlyph style={v} />,
              title: v[0]!.toUpperCase() + v.slice(1),
            }))}
            disabled={readOnly}
            onChange={(lineStyle) => onChange({ ...block, lineStyle })}
          />
          <SegmentedControl
            label="Weight"
            value={String(block.weight ?? 1)}
            options={["1", "2", "4", "8"].map((v) => ({
              value: v,
              label: v,
              title: `${v}px`,
            }))}
            disabled={readOnly}
            onChange={(v) => onChange({ ...block, weight: Number(v) })}
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
        </div>
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
    gap?: number | undefined;
    verticalAlign?: VerticalAlign | undefined;
    spaceTop?: number | undefined;
    spaceBottom?: number | undefined;
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
      <SegmentedControl
        label="Vertical alignment"
        value={row.verticalAlign ?? "top"}
        options={VERTICAL_ALIGNMENTS.map((v) => ({
          value: v,
          label: <VAlignGlyph align={v} />,
          title: v[0]!.toUpperCase() + v.slice(1),
        }))}
        disabled={readOnly}
        onChange={(verticalAlign) => onChange({ verticalAlign })}
      />
      <p className="text-xs text-white/50">
        Where a short column sits beside a tall one. `valign` is one of the few
        alignment properties Outlook honours, so this holds everywhere.
      </p>
      {/* No gutter on a row of one: there is nothing on either side of it.
          Bounded tighter than block spacing otherwise — the gutter comes out
          of the columns, and 48px of it leaves little of a three-column row. */}
      {row.layout !== "1" && (
        <SpaceField
          id="column-gap"
          label="Gap between columns"
          space={row.gap}
          max={48}
          disabled={readOnly}
          onChange={(gap) => onChange({ gap })}
        />
      )}
      <SpacingFields
        kind="columns"
        spaceTop={row.spaceTop}
        spaceBottom={row.spaceBottom}
        disabled={readOnly}
        onChange={(patch) => onChange(patch)}
      />
    </div>
  );
}

/** The line, drawn — three words in a segmented control is three ellipses. */
function RuleGlyph({ style }: { style: DividerStyle }) {
  return (
    <span
      aria-hidden
      className="block h-0 w-8 border-t-2 border-current"
      style={{ borderStyle: style }}
    />
  );
}

/** Two bars in a box, at the height the contents will sit. */
function VAlignGlyph({ align }: { align: VerticalAlign }) {
  return (
    <span
      aria-hidden
      className="flex h-3.5 w-5 flex-col justify-center gap-[2px]"
      style={{
        justifyContent:
          align === "top"
            ? "flex-start"
            : align === "bottom"
              ? "flex-end"
              : "center",
      }}
    >
      <span className="h-[2px] w-full rounded-[1px] bg-current opacity-70" />
      <span className="h-[2px] w-3 rounded-[1px] bg-current opacity-70" />
    </span>
  );
}

/** The ratio, drawn. Three words in a segmented control is three ellipses. */
function LayoutGlyph({ layout }: { layout: ColumnLayout }) {
  const parts =
    layout === "1"
      ? [1]
      : layout === "1-1"
        ? [1, 1]
        : layout === "1-1-1"
          ? [1, 1, 1]
          : layout === "2-1"
            ? [2, 1]
            : [1, 2];
  return (
    <span aria-hidden className="flex h-3 w-6 items-stretch gap-[2px]">
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
