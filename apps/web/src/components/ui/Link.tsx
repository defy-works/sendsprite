import NextLink, { type LinkProps as NextLinkProps } from "next/link";
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type AnchorAttrs = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  keyof NextLinkProps
>;

export interface LinkProps extends NextLinkProps, AnchorAttrs {
  /** Adds `target="_blank"` + `rel="noopener noreferrer"`. */
  external?: boolean;
  children?: ReactNode;
  className?: string;
}

const HOUSE_STYLE =
  "underline decoration-indigo-500 underline-offset-[4px] decoration-[1.5px] " +
  "hover:decoration-indigo-300 transition-[text-decoration-color] " +
  "duration-[var(--duration-fast)]";

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { external, className, children, target, rel, ...rest },
  ref,
) {
  const externalAttrs = external
    ? { target: target ?? "_blank", rel: rel ?? "noopener noreferrer" }
    : { target, rel };

  return (
    <NextLink
      ref={ref}
      className={cn(HOUSE_STYLE, className)}
      {...externalAttrs}
      {...rest}
    >
      {children}
    </NextLink>
  );
});
