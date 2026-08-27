import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconSparkle } from "./icons";

/**
 * What a list says when it has nothing in it.
 *
 * The icon is not decoration and it is not optional-by-omission: an empty
 * panel with three lines of centred text reads as a page that failed to load,
 * and the one thing an empty state must not do is look like an error. A mark
 * above the text is what makes "there is nothing here yet" legible as a state
 * rather than a fault.
 */
export function EmptyState({
  eyebrow = "Nothing here yet",
  title,
  body,
  action,
  icon,
  className,
}: {
  eyebrow?: string;
  title: string;
  body?: string;
  action?: ReactNode;
  /** Defaults to a neutral mark; pass the section's own icon where there is one. */
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "glass flex flex-col items-center gap-3 px-6 py-14 text-center",
        className,
      )}
    >
      <span
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/4 text-xl text-indigo-300/70"
      >
        {icon ?? <IconSparkle />}
      </span>
      <p className="num-stamp">{eyebrow}</p>
      <h3 className="text-lg font-medium">{title}</h3>
      {body && <p className="max-w-md text-sm text-white/60">{body}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
