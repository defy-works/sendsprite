"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

export interface Section {
  id: string;
  label: string;
}

/**
 * The in-page jump rail for Settings.
 *
 * Settings is one page rather than five routes because Sending, Retention and
 * Members are read together — "why can this team not send" is answered by
 * looking at two of them at once, and a tab strip hides one while you read the
 * other. The cost of one page is that it is long, which this pays for: the
 * rail is sticky, and it tracks what is on screen.
 *
 * `IntersectionObserver` with a top-biased root margin rather than scroll
 * maths: the observer already knows which sections are visible, and the margin
 * is what makes "current" mean the heading nearest the top of the viewport
 * instead of whichever section happens to occupy the most pixels.
 */
export function SectionRail({ sections }: { sections: readonly Section[] }) {
  const [active, setActive] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    const nodes = sections
      .map((s) => document.getElementById(s.id))
      .filter((n): n is HTMLElement => n !== null);
    if (nodes.length === 0) return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = sections.find((s) => seen.get(s.id));
        if (first) setActive(first.id);
      },
      // Top 12% to bottom 60%: a band just under the sticky header.
      { rootMargin: "-12% 0px -60% 0px", threshold: 0 },
    );
    for (const n of nodes) io.observe(n);
    return () => io.disconnect();
  }, [sections]);

  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-20 hidden w-44 shrink-0 flex-col gap-0.5 xl:flex"
    >
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          aria-current={active === s.id ? "true" : undefined}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm no-underline transition-colors duration-[var(--duration-fast)]",
            active === s.id
              ? "bg-white/6 text-white"
              : "text-white/50 hover:bg-white/4 hover:text-white/80",
          )}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}
