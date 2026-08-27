"use client";
import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { FileDrop } from "@/components/ui/FileDrop";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Skeleton } from "@/components/ui/Skeleton";
import { IconImage, IconTrash, IconUpload } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm";
import { cn } from "@/lib/cn";

export interface Asset {
  id: string;
  url: string;
  filename: string;
  size: number;
  width: number | null;
  height: number | null;
}

/**
 * Choosing the image for an `image` block.
 *
 * The block has only ever taken a URL, which meant the honest instruction was
 * "host this somewhere public yourself, then paste the address" — for a
 * product whose whole job is sending email, that is the feature not existing.
 * Uploading is the normal path now; the URL field stays, because a team with a
 * CDN should keep using it and because that is what the API accepts.
 *
 * Uploads go through `POST /api/assets` rather than a server action: the
 * payload is binary and megabytes, and a server action would need the app-wide
 * body limit raised to carry it.
 */
export function ImagePicker({
  value,
  onChange,
  disabled,
}: {
  /** The current `image.url`. */
  value: string;
  onChange: (url: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="flex gap-2">
        <Input
          value={value}
          placeholder="https://example.com/banner.png"
          disabled={disabled}
          aria-label="Image URL"
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          variant="subtle"
          disabled={disabled}
          icon={<IconImage />}
          className="shrink-0"
          onClick={() => setOpen(true)}
        >
          Library
        </Button>
      </div>
      <Library
        open={open}
        onDismiss={() => setOpen(false)}
        onPick={(url) => {
          onChange(url);
          setOpen(false);
        }}
      />
    </>
  );
}

const kb = (n: number) =>
  n < 1024 * 1024
    ? `${Math.round(n / 1024)} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;

function Library({
  open,
  onDismiss,
  onPick,
}: {
  open: boolean;
  onDismiss: () => void;
  onPick: (url: string) => void;
}) {
  const confirm = useConfirm();
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/assets", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const body = (await r.json()) as { assets: Asset[] };
      setAssets(body.assets);
    } catch {
      setError("Could not load your images. Reload the page and try again.");
      setAssets([]);
    }
  }, []);

  // Loaded when the dialog opens, not on mount: most editing sessions never
  // touch an image, and this is a query per open rather than per page.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const r = await fetch("/api/assets", { method: "POST", body: form });
      const body = (await r.json().catch(() => null)) as
        (Asset & { error?: string }) | null;
      if (!r.ok) {
        // The service writes these for a person — "that is not a PNG, JPEG,
        // GIF or WebP" — so they are shown as-is rather than replaced with a
        // status code.
        setError(body?.error ?? "The upload failed. Try again.");
        return;
      }
      if (body) {
        setAssets((prev) => [
          body,
          ...(prev ?? []).filter((a) => a.id !== body.id),
        ]);
        onPick(body.url);
      }
    } catch {
      setError("The upload failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Asset) => {
    const ok = await confirm({
      title: `Delete ${a.filename}?`,
      // Said plainly because it cannot be checked: a body stores the URL, not
      // the id, and the URL may be in mail that has already been delivered.
      body: "Any campaign or template still pointing at this image shows a broken image from then on — including mail already in someone's inbox, which keeps fetching it. Nothing here can tell you which those are.",
      confirmLabel: "Delete image",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/assets/${a.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(String(r.status));
      setAssets((prev) => (prev ?? []).filter((x) => x.id !== a.id));
    } catch {
      setError("Could not delete that image.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onDismiss={onDismiss}
      title="Images"
      description="Uploaded here and served from this instance, so a mail client can fetch them without a login."
      size="lg"
      dismissOnBackdrop
    >
      <FileDrop
        accept="image/png,image/jpeg,image/gif,image/webp"
        disabled={busy}
        label={busy ? "Uploading…" : "Drop an image here, or click to choose"}
        hint="PNG, JPEG, GIF or WebP, up to 2 MB. SVG is not accepted — it can carry a script."
        onFile={(f) => void upload(f)}
      />
      {error && <Alert>{error}</Alert>}

      {assets === null ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-square w-full rounded-md" />
          ))}
        </div>
      ) : assets.length === 0 ? (
        <p className="flex items-center gap-2 py-4 text-sm text-white/50">
          <IconUpload />
          Nothing uploaded yet.
        </p>
      ) : (
        <ul className="grid max-h-80 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
          {assets.map((a) => (
            <li key={a.id} className="group relative">
              <button
                type="button"
                disabled={busy}
                onClick={() => onPick(a.url)}
                title={`${a.filename} · ${kb(a.size)}${a.width ? ` · ${a.width}×${a.height}` : ""}`}
                className={cn(
                  "block w-full overflow-hidden rounded-md border border-white/12 bg-white/4",
                  "transition-colors hover:border-indigo-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500",
                )}
              >
                {/* A plain <img>: these are arbitrary user uploads served from
                    our own route, so there is nothing for next/image to
                    optimise and a loader would only add a round trip. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={a.url}
                  alt={a.filename}
                  className="aspect-square w-full bg-white object-contain"
                  loading="lazy"
                />
              </button>
              <Button
                size="iconSm"
                variant="ghost"
                aria-label={`Delete ${a.filename}`}
                disabled={busy}
                onClick={() => void remove(a)}
                className="absolute top-1 right-1 bg-black/60 text-white/70 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-red-500/70 hover:text-white"
              >
                <IconTrash />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Field
        id="asset-note"
        label="Or paste a URL"
        hint="An image already on your own CDN works exactly as well, and is what the API accepts."
      >
        <Input
          id="asset-note"
          placeholder="https://cdn.example.com/banner.png"
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const v = (e.target as HTMLInputElement).value.trim();
            if (v) onPick(v);
          }}
        />
      </Field>
    </Modal>
  );
}
