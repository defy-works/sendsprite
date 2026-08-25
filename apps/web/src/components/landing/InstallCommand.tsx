"use client";

import { useEffect, useRef, useState } from "react";

export const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/defy-works/sendsprite/main/install.sh | bash";

const RESET_MS = 1800;

/**
 * The one-line installer with a copy button. Mirrors ui/CopyField: the copy
 * button only renders once the clipboard API is known to exist (after
 * mount) so SSR and hydration agree; the text stays `select-all` either way.
 */
export function InstallCommand() {
  const [copied, setCopied] = useState(false);
  const [canCopy, setCanCopy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setCanCopy(Boolean(navigator.clipboard));
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), RESET_MS);
    } catch {
      // Selection fallback still works.
    }
  };

  return (
    <div className="glass flex items-stretch overflow-hidden rounded-md">
      <span
        aria-hidden
        className="hidden select-none items-center border-r border-white/12 px-4 font-mono text-xs text-indigo-300/80 sm:flex"
      >
        $
      </span>
      <pre className="min-w-0 flex-1 overflow-x-auto px-4 py-3.5 font-mono text-[13px] leading-relaxed text-white/90 select-all">
        <code>{INSTALL_COMMAND}</code>
      </pre>
      {canCopy && (
        <button
          type="button"
          onClick={() => void copy()}
          aria-live="polite"
          className="shrink-0 border-l border-white/12 px-4 font-mono text-[11px] tracking-[0.2em] text-indigo-300 uppercase transition-colors duration-[var(--duration-fast)] hover:bg-indigo-500/15 hover:text-indigo-200"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}
