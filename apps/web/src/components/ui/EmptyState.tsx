import type { ReactNode } from "react";

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="glass flex flex-col items-center gap-3 px-6 py-12 text-center">
      <p className="num-stamp">Nothing here yet</p>
      <h3 className="text-lg font-medium">{title}</h3>
      {body && <p className="max-w-md text-sm text-white/60">{body}</p>}
      {action}
    </div>
  );
}
