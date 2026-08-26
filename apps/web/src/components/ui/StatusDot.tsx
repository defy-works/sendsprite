import { cn } from "@/lib/cn";

export type Status = "ok" | "pending" | "warning" | "error" | "off";
const COLOR: Record<Status, string> = {
  ok: "bg-success shadow-[0_0_8px_rgba(34,197,94,0.6)]",
  pending: "bg-indigo-400 animate-pulse",
  warning: "bg-warning",
  error: "bg-danger",
  off: "bg-white/25",
};

export function StatusDot({
  status,
  className,
  label,
}: {
  status: Status;
  className?: string;
  label?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span aria-hidden className={cn("h-2 w-2 rounded-full", COLOR[status])} />
      {label && <span className="text-sm text-white/75">{label}</span>}
    </span>
  );
}
