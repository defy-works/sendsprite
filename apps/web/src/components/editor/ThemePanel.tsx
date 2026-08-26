"use client";
import {
  CONTENT_WIDTHS,
  FONT_FAMILIES,
  type CampaignTheme,
  type ContentWidth,
  type CornerStyle,
  type FontFamily,
} from "@sendsprite/shared";
import { Button } from "@/components/ui/Button";
import { ColorField } from "@/components/ui/ColorField";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { IconRefresh } from "@/components/ui/icons";

/**
 * What the whole body looks like, as opposed to one block in it.
 *
 * A sibling of the block inspector rather than part of it: this applies when
 * *nothing* is selected, which is also when an author is most likely thinking
 * about the email rather than about a paragraph. Selecting a block swaps it
 * out for that block's own styling, so the panel always answers the question
 * "what am I looking at".
 *
 * Every control writes `undefined` when it is cleared, which is the difference
 * between "white" and "the default, which happens to be white" — the second
 * one follows a change to the defaults and the first does not.
 */

const FONT_LABEL: Record<FontFamily, string> = {
  sans: "Sans",
  serif: "Serif",
  mono: "Mono",
};

export function ThemePanel({
  theme,
  readOnly,
  onChange,
}: {
  theme: CampaignTheme;
  readOnly: boolean;
  onChange: (next: CampaignTheme) => void;
}) {
  const set = <K extends keyof CampaignTheme>(k: K, v: CampaignTheme[K]) => {
    const next = { ...theme };
    // Deleted rather than set to `undefined`: the value is stored as jsonb and
    // compared with `JSON.stringify` for the dirty check, where a present key
    // holding `undefined` and an absent key are the same value but different
    // strings — which is a body that reports itself as edited for ever.
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };

  const dirty = Object.keys(theme).length > 0;

  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl
        label="Width"
        value={String(theme.contentWidth ?? 600)}
        options={CONTENT_WIDTHS.map((w) => ({
          value: String(w),
          label: `${w}`,
        }))}
        disabled={readOnly}
        onChange={(v) => set("contentWidth", Number(v) as ContentWidth)}
      />
      <SegmentedControl
        label="Font"
        value={theme.font ?? "sans"}
        options={FONT_FAMILIES.map((f) => ({
          value: f,
          label: FONT_LABEL[f],
        }))}
        disabled={readOnly}
        onChange={(v: FontFamily) => set("font", v)}
      />
      <SegmentedControl
        label="Card corners"
        value={theme.cardCorners ?? "soft"}
        options={[
          { value: "sharp" as const, label: "Sharp" },
          { value: "soft" as const, label: "Soft" },
          { value: "pill" as const, label: "Pill" },
        ]}
        disabled={readOnly}
        onChange={(v: CornerStyle) => set("cardCorners", v)}
      />
      <ColorField
        label="Page background"
        value={theme.pageBackground}
        fallback="#f3f4f6"
        disabled={readOnly}
        onChange={(v) => set("pageBackground", v)}
      />
      <ColorField
        label="Card background"
        value={theme.cardBackground}
        fallback="#ffffff"
        disabled={readOnly}
        onChange={(v) => set("cardBackground", v)}
      />
      <ColorField
        label="Text"
        value={theme.textColor}
        fallback="#111111"
        disabled={readOnly}
        onChange={(v) => set("textColor", v)}
      />
      <ColorField
        label="Links"
        value={theme.linkColor}
        fallback="#0000ee"
        disabled={readOnly}
        onChange={(v) => set("linkColor", v)}
      />
      <p className="text-xs text-white/45">
        Link colour is applied through a stylesheet rule, which Outlook on
        Windows ignores — links stay its default blue there. Everything else on
        this panel is inline and works everywhere.
      </p>
      {dirty && !readOnly && (
        <Button
          size="sm"
          variant="subtle"
          icon={<IconRefresh />}
          onClick={() => onChange({})}
        >
          Reset to defaults
        </Button>
      )}
    </div>
  );
}
