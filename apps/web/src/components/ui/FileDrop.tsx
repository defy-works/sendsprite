"use client";
import { useId, useRef, useState, type DragEvent } from "react";
import { cn } from "@/lib/cn";
import { IconUpload } from "./icons";

/**
 * A file picker that is a drop zone, and a real `<input type="file">`
 * underneath.
 *
 * The native input renders as an OS-drawn "Choose file" button with a grey
 * label beside it, which on this surface is the most obviously foreign control
 * in the product. It is kept — visually hidden — rather than replaced, because
 * it is the only thing that can open a file dialog at all, and it is what
 * carries the keyboard behaviour and the accessible name.
 *
 * Dropping is added on top. A CSV export is a file somebody just downloaded,
 * and dragging it out of the downloads bar is the shortest path there is.
 */
export function FileDrop({
  accept,
  disabled,
  onFile,
  label = "Drop a file here, or click to choose one",
  hint,
}: {
  accept?: string;
  disabled?: boolean;
  onFile: (file: File) => void;
  label?: string;
  hint?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [name, setName] = useState<string | null>(null);

  const take = (file: File | undefined | null) => {
    if (!file || disabled) return;
    setName(file.name);
    onFile(file);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.files?.[0]);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors",
        disabled && "opacity-50",
        over
          ? "border-indigo-400 bg-indigo-500/10"
          : "border-white/15 bg-white/2 hover:border-white/30",
      )}
    >
      <IconUpload className="text-xl text-indigo-300/70" />
      {/* The label is the click target, which is what lets the input itself be
          `sr-only` without losing the "click to choose" affordance. */}
      <label
        htmlFor={id}
        className={cn(
          "text-sm text-white/75",
          disabled ? "cursor-not-allowed" : "cursor-pointer hover:text-white",
        )}
      >
        {name ?? label}
      </label>
      {hint && <p className="text-xs text-white/45">{hint}</p>}
      <input
        ref={input}
        id={id}
        type="file"
        accept={accept}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => {
          take(e.target.files?.[0]);
          // Cleared so choosing the *same* file twice fires `change` again —
          // the second attempt after a failed import is the common case.
          e.target.value = "";
        }}
      />
    </div>
  );
}
