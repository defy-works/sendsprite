import type { ReactNode } from "react";

/** Step title. The page owns its `<h1>`; steps are sections of it. */
export function Heading({ children }: { children: ReactNode }) {
  return <h2 className="text-lg font-medium">{children}</h2>;
}

export function Panel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="glass flex flex-col gap-3 p-4">
      <h2 className="num-stamp">{title}</h2>
      {children}
    </section>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-red-300">
      {children}
    </p>
  );
}

/** Amber, non-blocking: the action succeeded but something needs attention. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
      {children}
    </p>
  );
}
