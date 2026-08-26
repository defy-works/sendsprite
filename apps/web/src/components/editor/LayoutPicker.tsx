"use client";
import { useCallback, useEffect, useState } from "react";
import type { CampaignBlock, CampaignTheme } from "@sendsprite/shared";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Toggle";
import { IconPlus, IconTrash } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { LAYOUT_PRESETS, type LayoutPreset } from "@/lib/editor/layouts";
import {
  deleteLayoutAction,
  listLayoutsAction,
  saveLayoutAction,
} from "@/app/app/campaigns/layout-actions";

export interface SavedLayoutRow {
  id: string;
  name: string;
  blocks: CampaignBlock[];
  theme: CampaignTheme | null;
}

/**
 * The layouts section of the palette, and the dialog for saving one.
 *
 * Two lists, deliberately distinct. The presets are values in the bundle —
 * always there, the same on every instance, and a reasonable answer to "what
 * does an email look like". The saved ones are the team's, and they are where
 * the feature stops being a demo: everybody's footer is different, and typing
 * the company address into every campaign is work software should absorb.
 *
 * Inserting appends blocks and nothing else. A layout that carries a theme
 * *offers* it — applying one silently would let dropping in a footer repaint
 * the whole email.
 */
export function LayoutPicker({
  disabled,
  onInsert,
  onApplyTheme,
  /** The current body, for "save these as a layout". */
  currentBlocks,
  currentTheme,
}: {
  disabled: boolean;
  onInsert: (blocks: CampaignBlock[]) => void;
  onApplyTheme: (theme: CampaignTheme) => void;
  currentBlocks: CampaignBlock[];
  currentTheme: CampaignTheme | null;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [saved, setSaved] = useState<SavedLayoutRow[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);

  const reload = useCallback(async () => {
    const res = await listLayoutsAction();
    if (res.ok) setSaved(res.data);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Inserts, and asks about the theme separately.
   *
   * The ask only happens when the layout actually carries one and it differs
   * from what the body already has — a confirm that always says yes to the
   * same thing is a confirm people stop reading.
   */
  const insert = async (l: LayoutPreset | SavedLayoutRow) => {
    onInsert(l.blocks);
    const theme = "theme" in l ? l.theme : undefined;
    if (!theme || JSON.stringify(theme) === JSON.stringify(currentTheme ?? {}))
      return;
    const ok = await confirm({
      title: `Use ${l.name}'s colours too?`,
      body: "This layout was designed with its own page and card colours. Applying them changes the whole body, not just the blocks you inserted.",
      confirmLabel: "Apply the theme",
      cancelLabel: "Blocks only",
    });
    if (ok) onApplyTheme(theme);
  };

  const remove = async (l: SavedLayoutRow) => {
    const ok = await confirm({
      title: `Delete the "${l.name}" layout?`,
      body: "Bodies you already built from it are untouched — a layout is copied in, not linked.",
      confirmLabel: "Delete layout",
      tone: "danger",
    });
    if (!ok) return;
    const res = await deleteLayoutAction(l.id);
    if (!res.ok) return toast({ tone: "error", title: res.error });
    setSaved((prev) => prev.filter((x) => x.id !== l.id));
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="num-stamp">Layouts</p>
      <div className="flex flex-col gap-1">
        {LAYOUT_PRESETS.map((l) => (
          <Row
            key={l.id}
            name={l.name}
            description={l.description}
            disabled={disabled}
            onInsert={() => void insert(l)}
          />
        ))}
      </div>

      {saved.length > 0 && (
        <>
          <p className="num-stamp pt-1">Saved</p>
          <div className="flex flex-col gap-1">
            {saved.map((l) => (
              <Row
                key={l.id}
                name={l.name}
                description={`${l.blocks.length} block${l.blocks.length === 1 ? "" : "s"}`}
                disabled={disabled}
                onInsert={() => void insert(l)}
                onDelete={() => void remove(l)}
              />
            ))}
          </div>
        </>
      )}

      <Button
        size="sm"
        variant="subtle"
        icon={<IconPlus />}
        disabled={disabled || currentBlocks.length === 0}
        title={
          currentBlocks.length === 0
            ? "Add some blocks first."
            : "Save this body as a reusable layout"
        }
        onClick={() => setSaveOpen(true)}
      >
        Save this as a layout
      </Button>

      <SaveDialog
        open={saveOpen}
        onDismiss={() => setSaveOpen(false)}
        blocks={currentBlocks}
        theme={currentTheme}
        onSaved={(row) => {
          setSaved((prev) =>
            [...prev, row].sort((a, b) => a.name.localeCompare(b.name)),
          );
          setSaveOpen(false);
          toast({ tone: "success", title: `Saved "${row.name}"` });
        }}
      />
    </div>
  );
}

function Row({
  name,
  description,
  disabled,
  onInsert,
  onDelete,
}: {
  name: string;
  description: string;
  disabled: boolean;
  onInsert: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="group flex items-center gap-1">
      <button
        type="button"
        disabled={disabled}
        onClick={onInsert}
        title={description}
        // The name has to say what the click does. Without it the accessible
        // name is the tile's own two lines — "Footer A rule, your address,
        // and the line the law wants" — which names the thing and buries the
        // verb, and reads as one run-on string to a screen reader.
        aria-label={`Insert the ${name} layout`}
        className="flex min-w-0 flex-1 cursor-pointer flex-col rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="truncate text-xs text-white/85">{name}</span>
        <span className="truncate text-[10px] text-white/40">
          {description}
        </span>
      </button>
      {onDelete && (
        <Button
          size="iconSm"
          variant="ghost"
          aria-label={`Delete the ${name} layout`}
          disabled={disabled}
          onClick={onDelete}
          className="shrink-0 text-white/25 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-red-300"
        >
          <IconTrash />
        </Button>
      )}
    </div>
  );
}

function SaveDialog({
  open,
  onDismiss,
  blocks,
  theme,
  onSaved,
}: {
  open: boolean;
  onDismiss: () => void;
  blocks: CampaignBlock[];
  theme: CampaignTheme | null;
  onSaved: (row: SavedLayoutRow) => void;
}) {
  const [name, setName] = useState("");
  const [withTheme, setWithTheme] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await saveLayoutAction({
        name,
        blocks,
        theme: withTheme ? theme : null,
      });
      if (!res.ok) return setError(res.error);
      setName("");
      onSaved(res.data);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onDismiss={onDismiss}
      title="Save as a layout"
      description={`The ${blocks.length} block${blocks.length === 1 ? "" : "s"} in this body, copied so you can drop them into another one.`}
      size="sm"
      footer={
        <>
          <Button variant="subtle" onClick={onDismiss}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={name.trim() === ""}
            onClick={() => void save()}
          >
            Save layout
          </Button>
        </>
      }
    >
      <Field id="layout-name" label="Name" error={error ?? undefined}>
        <Input
          id="layout-name"
          value={name}
          data-autofocus
          maxLength={80}
          placeholder="Footer"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) void save();
          }}
        />
      </Field>
      <Switch
        checked={withTheme}
        onChange={setWithTheme}
        label="Include the colours"
        hint="The layout then offers this body's page and card colours when it is inserted somewhere else."
      />
      <p className="text-xs text-white/50">
        A copy, not a link: editing this body later does not change the layout,
        and editing the layout does not change any body built from it.
      </p>
    </Modal>
  );
}
