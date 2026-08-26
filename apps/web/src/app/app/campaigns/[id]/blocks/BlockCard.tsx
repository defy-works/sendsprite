"use client";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CampaignBlock } from "@sendsprite/shared";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/cn";
import { BLOCK_LABELS, blockIssue, type EditorBlock } from "../../preview";
import { InlineEditor } from "./InlineEditor";

/**
 * One block in the editor: a drag handle, the fields its kind carries, and
 * whatever the contract has to say about it right now.
 *
 * The forms are per kind rather than a generic key/value grid because the
 * contract is a discriminated union — `alt` is required on an image and
 * meaningless on a spacer, and a grid would have to re-derive that from the
 * schema at runtime to say so.
 */

const HEADING_LEVELS = [1, 2, 3] as const;
type HeadingLevel = (typeof HEADING_LEVELS)[number];

const headingLevelOf = (value: string): HeadingLevel =>
  HEADING_LEVELS.find((l) => String(l) === value) ?? 2;

function BlockFields({
  block,
  readOnly,
  id,
  onChange,
}: {
  block: CampaignBlock;
  readOnly: boolean;
  id: string;
  onChange: (block: CampaignBlock) => void;
}) {
  switch (block.kind) {
    case "heading":
      return (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-24">
            <Label htmlFor={`${id}-level`}>Size</Label>
            <Select
              id={`${id}-level`}
              value={String(block.level)}
              disabled={readOnly}
              onChange={(v) => onChange({ ...block, level: headingLevelOf(v) })}
              options={HEADING_LEVELS.map((l) => ({
                value: String(l),
                label: `H${l}`,
              }))}
            />
          </div>
          <div className="min-w-60 flex-1">
            <Label htmlFor={`${id}-text`}>Text</Label>
            <Input
              id={`${id}-text`}
              value={block.text}
              disabled={readOnly}
              onChange={(e) => onChange({ ...block, text: e.target.value })}
            />
          </div>
        </div>
      );

    case "text":
      return (
        <InlineEditor
          value={block.html}
          readOnly={readOnly}
          label="Campaign text block"
          onChange={(html) => onChange({ ...block, html })}
        />
      );

    case "button":
      return (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-40 flex-1">
            <Label htmlFor={`${id}-label`}>Label</Label>
            <Input
              id={`${id}-label`}
              value={block.label}
              maxLength={200}
              disabled={readOnly}
              onChange={(e) => onChange({ ...block, label: e.target.value })}
            />
          </div>
          <div className="min-w-60 flex-1">
            <Label htmlFor={`${id}-url`}>Links to</Label>
            <Input
              id={`${id}-url`}
              value={block.url}
              placeholder="https://example.com/offer"
              disabled={readOnly}
              onChange={(e) => onChange({ ...block, url: e.target.value })}
            />
          </div>
        </div>
      );

    case "image":
      return (
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor={`${id}-src`}>Image URL</Label>
            <Input
              id={`${id}-src`}
              value={block.url}
              placeholder="https://example.com/banner.png"
              disabled={readOnly}
              onChange={(e) => onChange({ ...block, url: e.target.value })}
            />
            <p className="mt-1 text-xs text-white/50">
              Hosted somewhere public. Mail clients do not fetch anything behind
              a login.
            </p>
          </div>
          <div>
            <Label htmlFor={`${id}-alt`}>Alt text</Label>
            <Input
              id={`${id}-alt`}
              value={block.alt}
              maxLength={300}
              disabled={readOnly}
              onChange={(e) => onChange({ ...block, alt: e.target.value })}
            />
            <p className="mt-1 text-xs text-white/50">
              Required. Most clients block images on first open, so for most
              recipients this is the image.
            </p>
          </div>
          <div>
            <Label htmlFor={`${id}-href`}>Links to (optional)</Label>
            <Input
              id={`${id}-href`}
              value={block.href ?? ""}
              placeholder="https://example.com"
              disabled={readOnly}
              onChange={(e) =>
                onChange(
                  e.target.value.trim()
                    ? { ...block, href: e.target.value }
                    : // Omitted, not empty: `href` is `.optional()`, and an
                      // empty string would fail `SafeUrl.min(1)`.
                      { kind: "image", url: block.url, alt: block.alt },
                )
              }
            />
          </div>
        </div>
      );

    case "divider":
      return (
        <p className="text-sm text-white/50">
          A horizontal rule. Nothing to configure.
        </p>
      );

    case "spacer":
      return (
        <div className="w-40">
          <Label htmlFor={`${id}-size`}>Height (px)</Label>
          <Input
            id={`${id}-size`}
            type="number"
            min={4}
            max={96}
            value={block.size}
            disabled={readOnly}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange({
                ...block,
                // A non-number is stored as 0 rather than dropped, so the
                // block reports "too small" instead of silently keeping the
                // old height while the field shows something else.
                size: Number.isFinite(n) ? Math.trunc(n) : 0,
              });
            }}
          />
        </div>
      );
  }
}

export function BlockCard({
  item,
  index,
  count,
  readOnly,
  invalid,
  onChange,
  onRemove,
}: {
  item: EditorBlock;
  index: number;
  count: number;
  readOnly: boolean;
  /** Set when the *preview* blamed this block, which is the louder signal. */
  invalid: boolean;
  onChange: (block: CampaignBlock) => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: readOnly });
  const issue = blockIssue(item.block);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "glass flex flex-col gap-3 p-4",
        isDragging && "z-10 opacity-80",
        (issue || invalid) && "border border-amber-400/40",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {!readOnly && (
            <button
              type="button"
              // The whole card is not the handle: a card full of inputs that
              // starts a drag on mousedown is a card whose text cannot be
              // selected.
              className="cursor-grab rounded px-2 py-1 text-white/40 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
              aria-label={`Reorder ${BLOCK_LABELS[item.block.kind]} block, position ${index + 1} of ${count}`}
              {...attributes}
              {...listeners}
            >
              ⠿
            </button>
          )}
          <span className="num-stamp">
            {index + 1}. {BLOCK_LABELS[item.block.kind]}
          </span>
        </div>
        {!readOnly && (
          <Button size="sm" variant="subtle" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>

      <BlockFields
        block={item.block}
        readOnly={readOnly}
        id={item.id}
        onChange={onChange}
      />

      {issue && (
        <p role="alert" className="text-xs text-amber-300">
          {issue}
        </p>
      )}
    </li>
  );
}
