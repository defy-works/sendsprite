"use client";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

const RESET_MS = 1500;

/**
 * Monospace value with a copy button. Without the clipboard API (http,
 * old browsers) the text stays `select-all` so a click selects it for Ctrl+C.
 */
export function CopyField({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Decided after mount so SSR and hydration render the same markup.
  const [canCopy, setCanCopy] = useState(false);

  useEffect(() => {
    setCanCopy(Boolean(navigator.clipboard));
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), RESET_MS);
    } catch {
      // Selection fallback below still works.
    }
  };

  return (
    <span
      className={cn("inline-flex max-w-full items-center gap-2", className)}
    >
      <code className="select-all break-all rounded bg-white/8 px-1.5 py-0.5 text-xs">
        {value}
      </code>
      {canCopy && (
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? "Copied" : `Copy ${value}`}
          className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-indigo-300 hover:text-indigo-200"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </span>
  );
}
