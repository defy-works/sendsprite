"use client";
import Link from "next/link";
import { Logo, MarkTile } from "@/components/ui/Logo";
import { cn } from "@/lib/cn";
import { railWidthMd, useShell } from "./ShellState";

/**
 * The wordmark, in a block exactly as wide as the sidebar beneath it.
 *
 * This was a wordmark followed by a `/` separator, which put a slash where the
 * sidebar's edge was — two different marks doing the same job a few pixels
 * apart. The divider between the instance and the team should be the same
 * vertical rule that divides the rail from the page, continued upward, which
 * means this block has to track the rail's width: full when the sidebar is
 * open, and the mark alone at 60px when it is collapsed, so the line never
 * jogs.
 *
 * Below `md` the rail is a drawer and there is no line to meet, so the block
 * shrinks to its contents.
 */
export function LogoBlock() {
  const { collapsed, ready } = useShell();
  return (
    <div
      className={cn(
        "flex h-full shrink-0 items-center md:border-r md:border-white/10",
        ready && "transition-[width] duration-[var(--duration-normal)]",
        railWidthMd(collapsed),
        collapsed ? "md:justify-center md:px-0" : "md:px-3",
      )}
    >
      <Link
        href="/app"
        aria-label="Sendsprite"
        className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-opacity hover:opacity-80"
      >
        <MarkTile scale={1.15} className={collapsed ? "" : "md:hidden"} />
        {!collapsed && <Logo scale={1.9} className="hidden md:block" />}
      </Link>
    </div>
  );
}
