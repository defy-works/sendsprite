"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { IconAlert, IconCheckCircle, IconInfo, IconX } from "./icons";

export type ToastTone = "success" | "error" | "info";

export interface ToastOptions {
  title: ReactNode;
  body?: ReactNode;
  tone?: ToastTone;
  /** Milliseconds on screen. `0` pins it until dismissed. Errors default to 0. */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
}

type Push = (o: ToastOptions) => void;

const Ctx = createContext<Push | null>(null);

const DEFAULT_MS = 4000;

const TONE: Record<
  ToastTone,
  { icon: typeof IconInfo; ring: string; text: string }
> = {
  success: {
    icon: IconCheckCircle,
    ring: "border-success/40 bg-success/12",
    text: "text-green-200",
  },
  error: {
    icon: IconAlert,
    ring: "border-danger/45 bg-danger/12",
    text: "text-red-200",
  },
  info: {
    icon: IconInfo,
    ring: "border-indigo-400/40 bg-indigo-500/12",
    text: "text-indigo-200",
  },
};

/**
 * Transient confirmations, bottom-right.
 *
 * The dashboard used to say "Saved." in a `<span>` next to the button, which
 * only works while the button is on screen — a save from the bottom of a long
 * settings page confirmed itself somewhere the author could not see. A toast
 * is the same message in a place that does not depend on scroll position.
 *
 * `aria-live="polite"` rather than `assertive`: these narrate the result of
 * something the user just did, so interrupting them mid-word is rude and
 * unnecessary. An error defaults to pinned, because a failure the user did not
 * happen to be looking at is a failure they will report as "it did nothing".
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setItems((list) => list.filter((i) => i.id !== id));
  }, []);

  const push = useCallback<Push>(
    (o) => {
      const id = next.current++;
      setItems((list) => [...list.slice(-3), { ...o, id }]);
      const ms = o.duration ?? (o.tone === "error" ? 0 : DEFAULT_MS);
      if (ms > 0)
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), ms),
        );
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const mounted = useMounted();

  return (
    <Ctx.Provider value={push}>
      {children}
      {mounted &&
        createPortal(
          <div
            aria-live="polite"
            className="pointer-events-none fixed right-4 bottom-4 z-200 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
          >
            {items.map((i) => {
              const tone = TONE[i.tone ?? "info"];
              const Glyph = tone.icon;
              return (
                <div
                  key={i.id}
                  role="status"
                  className={cn(
                    "glass-strong pointer-events-auto flex items-start gap-3 border p-3.5 shadow-glass",
                    "motion-safe:animate-[toast-in_var(--duration-normal)_var(--ease-out-soft)]",
                    tone.ring,
                  )}
                >
                  <Glyph className={cn("mt-0.5 text-base", tone.text)} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="text-sm font-medium break-words">{i.title}</p>
                    {i.body && (
                      <p className="text-xs break-words text-white/65">
                        {i.body}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={() => dismiss(i.id)}
                    className="shrink-0 cursor-pointer rounded p-0.5 text-white/45 transition-colors hover:text-white"
                  >
                    <IconX className="text-sm" />
                  </button>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </Ctx.Provider>
  );
}

/** Portals need a DOM; this keeps SSR and the first client render identical. */
function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

/**
 * Returns `toast(options)`. Outside a provider it is a no-op — a missing
 * confirmation is a cosmetic loss, unlike a missing confirm dialog.
 */
export function useToast(): Push {
  const push = useContext(Ctx);
  return useMemo(() => push ?? (() => {}), [push]);
}
