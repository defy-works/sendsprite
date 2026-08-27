import type { MDXComponents } from "mdx/types";
import Link from "next/link";

/**
 * Component map for every `.mdx` page (`@next/mdx` resolves this file by
 * name). The docs use the same tokens as the landing page: mono eyebrow
 * labels, hairline rules, indigo accents and a ~72ch prose column, so plain
 * Markdown lands inside the design system without any per-page classes.
 */
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: ({ children, ...props }) => (
      <h1
        {...props}
        className="metric-xl mt-2 mb-6 text-white"
        style={{ fontSize: "clamp(2rem, 4vw, 2.75rem)" }}
      >
        {children}
      </h1>
    ),
    h2: ({ children, ...props }) => (
      <h2
        {...props}
        className="mt-14 mb-4 border-t border-white/12 pt-8 font-display text-2xl font-bold tracking-[-0.03em] text-white"
      >
        {children}
      </h2>
    ),
    h3: ({ children, ...props }) => (
      <h3
        {...props}
        className="mt-9 mb-3 font-display text-lg font-semibold tracking-[-0.01em] text-white"
      >
        {children}
      </h3>
    ),
    p: ({ children, ...props }) => (
      <p {...props} className="my-4 text-[15px] leading-relaxed text-white/70">
        {children}
      </p>
    ),
    a: ({ children, href, ...props }) => {
      const className =
        "text-indigo-300 underline decoration-indigo-400/40 underline-offset-4 transition-colors duration-[var(--duration-fast)] hover:text-indigo-200 hover:decoration-indigo-300";
      return href && href.startsWith("/") ? (
        <Link href={href} className={className}>
          {children}
        </Link>
      ) : (
        <a {...props} href={href} className={className}>
          {children}
        </a>
      );
    },
    ul: ({ children, ...props }) => (
      <ul
        {...props}
        className="my-4 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-white/70 marker:text-indigo-400/70"
      >
        {children}
      </ul>
    ),
    ol: ({ children, ...props }) => (
      <ol
        {...props}
        className="my-4 list-decimal space-y-2 pl-5 text-[15px] leading-relaxed text-white/70 marker:font-mono marker:text-indigo-400/70"
      >
        {children}
      </ol>
    ),
    li: ({ children, ...props }) => (
      <li {...props} className="pl-1">
        {children}
      </li>
    ),
    strong: ({ children, ...props }) => (
      <strong {...props} className="font-semibold text-white">
        {children}
      </strong>
    ),
    blockquote: ({ children, ...props }) => (
      <blockquote
        {...props}
        className="my-6 border-l-2 border-indigo-500/60 bg-indigo-950/30 px-5 py-1 text-[15px] text-white/75"
      >
        {children}
      </blockquote>
    ),
    hr: (props) => <div {...props} className="hairline my-10" aria-hidden />,
    // `pre` owns the frame. A fenced block without a language produces a
    // `code` with no className, which would otherwise pick up the inline
    // chip style below — the child overrides undo it for every block.
    pre: ({ children, ...props }) => (
      <pre
        {...props}
        className="glass my-6 overflow-x-auto rounded-md px-5 py-4 font-mono text-[13px] leading-relaxed text-white/85 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[1em] [&>code]:text-inherit"
      >
        {children}
      </pre>
    ),
    code: ({ children, className, ...props }) => (
      <code
        {...props}
        className={
          className
            ? className
            : "rounded-xs bg-white/8 px-1.5 py-0.5 font-mono text-[0.86em] text-indigo-200"
        }
      >
        {children}
      </code>
    ),
    table: ({ children, ...props }) => (
      <div className="my-6 overflow-x-auto">
        {/* Wraps on a wide column, scrolls instead of squashing below ~36rem. */}
        <table
          {...props}
          className="w-full min-w-[34rem] border-collapse text-left"
        >
          {children}
        </table>
      </div>
    ),
    th: ({ children, ...props }) => (
      <th
        {...props}
        className="border-b border-white/20 px-3 py-2.5 font-mono text-[11px] tracking-[0.16em] text-indigo-300/80 uppercase"
      >
        {children}
      </th>
    ),
    td: ({ children, ...props }) => (
      <td
        {...props}
        className="border-b border-white/10 px-3 py-2.5 align-top text-[14px] leading-relaxed text-white/70"
      >
        {children}
      </td>
    ),
    ...components,
  };
}
