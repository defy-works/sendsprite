"use client";
import type { LeafBlock } from "@sendsprite/shared";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { ImagePicker } from "./ImagePicker";
import { InlineEditor } from "./InlineEditor";

/**
 * The content a block carries — its words, its URL, its height.
 *
 * Separate from the inspector, which owns how it *looks*. The split is the one
 * the contract already makes: `text` and `url` are required and validated,
 * `align` and `color` are optional presentation, and mixing the two in one
 * panel is how a required field ends up below three colour swatches.
 *
 * Per kind rather than a generic key/value grid because the contract is a
 * discriminated union: `alt` is required on an image and meaningless on a
 * spacer, and a grid would have to re-derive that from the schema at runtime.
 */

const HEADING_LEVELS = [1, 2, 3] as const;
type HeadingLevel = (typeof HEADING_LEVELS)[number];

const headingLevelOf = (value: string): HeadingLevel =>
  HEADING_LEVELS.find((l) => String(l) === value) ?? 2;

export function BlockFields({
  block,
  readOnly,
  id,
  onChange,
}: {
  block: LeafBlock;
  readOnly: boolean;
  id: string;
  onChange: (block: LeafBlock) => void;
}) {
  switch (block.kind) {
    case "heading":
      return (
        <div className="flex flex-wrap items-end gap-3">
          <Field id={`${id}-level`} label="Size" className="w-24">
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
          </Field>
          <Field id={`${id}-text`} label="Text" className="min-w-52 flex-1">
            <Input
              id={`${id}-text`}
              value={block.text}
              disabled={readOnly}
              onChange={(e) => onChange({ ...block, text: e.target.value })}
            />
          </Field>
        </div>
      );

    case "text":
      return (
        <InlineEditor
          value={block.html}
          readOnly={readOnly}
          label="Text block"
          onChange={(html) => onChange({ ...block, html })}
        />
      );

    case "button":
      return (
        <div className="flex flex-wrap items-end gap-3">
          <Field id={`${id}-label`} label="Label" className="min-w-36 flex-1">
            <Input
              id={`${id}-label`}
              value={block.label}
              maxLength={200}
              disabled={readOnly}
              onChange={(e) => onChange({ ...block, label: e.target.value })}
            />
          </Field>
          <Field id={`${id}-url`} label="Links to" className="min-w-52 flex-1">
            <Input
              id={`${id}-url`}
              value={block.url}
              placeholder="https://example.com/offer"
              disabled={readOnly}
              onChange={(e) => onChange({ ...block, url: e.target.value })}
            />
          </Field>
        </div>
      );

    case "image":
      return (
        <div className="flex flex-col gap-3">
          <Field
            id={`${id}-src`}
            label="Image"
            hint="Upload one, or point at a URL of your own. Mail clients do not fetch anything behind a login."
          >
            <ImagePicker
              value={block.url}
              disabled={readOnly}
              onChange={(url) => onChange({ ...block, url })}
            />
          </Field>
          {block.url && (
            <div className="overflow-hidden rounded-md border border-white/10 bg-white/4">
              {/* Shown at the size the block will render, so "50% width" is a
                  thing you can see rather than a number you have to imagine.
                  A plain <img>: the source is arbitrary and often remote. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={block.url}
                alt=""
                className="mx-auto max-h-40 bg-white object-contain"
                style={{ width: `${block.width ?? 100}%` }}
              />
            </div>
          )}
          <Field
            id={`${id}-alt`}
            label="Alt text"
            required
            hint="Most clients block images on first open, so for most recipients this is the image."
          >
            <Input
              id={`${id}-alt`}
              value={block.alt}
              maxLength={300}
              disabled={readOnly}
              onChange={(e) => onChange({ ...block, alt: e.target.value })}
            />
          </Field>
          <Field id={`${id}-href`} label="Links to (optional)">
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
                      // empty string would fail `SafeUrl`. Spread-and-delete
                      // rather than a fresh literal so the block keeps its
                      // presentation fields.
                      stripHref(block),
                )
              }
            />
          </Field>
        </div>
      );

    case "divider":
      return (
        <p className="text-sm text-white/50">
          A horizontal rule. Its colour is under Style.
        </p>
      );

    case "spacer":
      return (
        <Field id={`${id}-size`} label="Height (px)" className="w-40">
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
        </Field>
      );
  }
}

function stripHref(block: LeafBlock & { kind: "image" }): LeafBlock {
  const next = { ...block };
  delete next.href;
  return next;
}
