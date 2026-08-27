"use client";
import { useId } from "react";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";

/**
 * Space, as a short list of steps rather than a number field.
 *
 * A pixel input invites 37px, and 37px is a value nobody chose on purpose and
 * everybody has to look at. The steps are a doubling scale, which is what the
 * rest of the type and spacing in a rendered email is built on, and `0` is
 * spelled "None" because that is what it means to the person reading the
 * label.
 */
export const SPACE_STEPS = [0, 4, 8, 16, 24, 32, 48, 64, 96] as const;

const LABELS: Record<number, string> = {
  0: "None",
  4: "4 — hair",
  8: "8 — tight",
  16: "16",
  24: "24",
  32: "32",
  48: "48 — loose",
  64: "64",
  96: "96 — a screen",
};

export function SpaceField({
  id,
  label,
  space,
  disabled,
  onChange,
  max = 96,
  zeroIsAbsent = true,
}: {
  /**
   * A stable id, because the control is a listbox rather than a `<select>`:
   * its options live in `#${id}-listbox`, which is what a test reaches for.
   * Falls back to a generated one where the field is one of a kind.
   */
  id?: string;
  label: string;
  space: number | undefined;
  disabled?: boolean;
  onChange: (next: number | undefined) => void;
  /** The row gap is bounded tighter than block spacing is. */
  max?: number;
  /**
   * Whether choosing "None" means *absent* or means *zero*.
   *
   * For a block's own space the two are the same thing, and absent is the one
   * to store: the renderer writes no vertical padding for it, which is what
   * keeps a body written before spacing existed rendering byte for byte as it
   * did. For the card's padding they are opposites — absent is the 24px
   * default and zero is a card with no gutter at all — so that field stores
   * the number.
   */
  zeroIsAbsent?: boolean;
}) {
  const auto = useId();
  const fieldId = id ?? auto;
  const value = (v: number) => (v === 0 && zeroIsAbsent ? undefined : v);
  return (
    <Field id={fieldId} label={label}>
      <Select
        id={fieldId}
        value={String(space ?? 0)}
        disabled={disabled}
        onChange={(v) => onChange(value(Number(v)))}
        options={SPACE_STEPS.filter((s) => s <= max).map((s) => ({
          value: String(s),
          label: LABELS[s] ?? String(s),
        }))}
      />
    </Field>
  );
}

/** The pair every block carries: room above, room below. */
export function SpacingFields({
  spaceTop,
  spaceBottom,
  disabled,
  onChange,
}: {
  spaceTop: number | undefined;
  spaceBottom: number | undefined;
  disabled?: boolean;
  onChange: (patch: {
    spaceTop?: number | undefined;
    spaceBottom?: number | undefined;
  }) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <SpaceField
        id="space-above"
        label="Space above"
        space={spaceTop}
        disabled={disabled}
        onChange={(spaceTop) => onChange({ spaceTop })}
      />
      <SpaceField
        id="space-below"
        label="Space below"
        space={spaceBottom}
        disabled={disabled}
        onChange={(spaceBottom) => onChange({ spaceBottom })}
      />
    </div>
  );
}
