import NextLink from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconArrowLeft } from "./icons";

/**
 * The top of every dashboard page: an optional back link, a title, one line of
 * context, and the actions for this page on the right.
 *
 * Pages were writing their own header, so the title was `text-lg` on one page
 * and `text-xl` on the next, the back link was sometimes a `num-stamp` arrow
 * and sometimes nothing, and the primary action floated wherever the flexbox
 * put it. One component is what makes the dashboard read as one product.
 */
export function PageHeader({
  title,
  eyebrow,
  description,
  back,
  actions,
  className,
}: {
  title: ReactNode;
  /** Small mono label above the title — the section this page belongs to. */
  eyebrow?: ReactNode;
  description?: ReactNode;
  back?: { href: string; label: string };
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-6 gap-y-4",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        {back && (
          <NextLink
            href={back.href}
            className="group flex w-fit items-center gap-1.5 text-xs tracking-[0.16em] text-white/45 uppercase no-underline transition-colors hover:text-indigo-300"
          >
            <IconArrowLeft className="transition-transform duration-[var(--duration-fast)] group-hover:-translate-x-0.5" />
            {back.label}
          </NextLink>
        )}
        {eyebrow && !back && <p className="num-stamp">{eyebrow}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-medium tracking-[-0.01em]">{title}</h1>
        </div>
        {description && (
          <p className="max-w-2xl text-sm text-white/60">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2.5">{actions}</div>
      )}
    </header>
  );
}
