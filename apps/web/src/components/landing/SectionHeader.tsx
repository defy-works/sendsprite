import type { ReactNode } from "react";

/**
 * Editorial section header: numbered mono eyebrow on the left, an optional
 * trailing note on the right, a hairline underneath. Used by every section
 * so the page reads as one numbered document.
 */
export function SectionHeader({
  num,
  label,
  end,
  children,
}: {
  num: string;
  label: string;
  end?: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between gap-4">
        <p className="num-stamp">
          {num} — {label}
        </p>
        {end && (
          <p className="num-stamp hidden text-white/35 sm:block">{end}</p>
        )}
      </div>
      <div className="hairline" aria-hidden />
      {children}
    </header>
  );
}
