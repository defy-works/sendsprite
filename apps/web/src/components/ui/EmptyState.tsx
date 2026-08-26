import type { ReactNode } from "react";

export function EmptyState({
  eyebrow = "Nothing here yet",
  title,
  body,
  action,
}: {
  eyebrow?: string;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="glass flex flex-col items-center gap-3 px-6 py-12 text-center">
      <p className="num-stamp">{eyebrow}</p>
      <h3 className="text-lg font-medium">{title}</h3>
      {body && <p className="max-w-md text-sm text-white/60">{body}</p>}
      {action}
    </div>
  );
}
