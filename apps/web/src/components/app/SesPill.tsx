import Link from "next/link";
import { IconAlert, IconCheckCircle, IconClock } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import type { TeamAws } from "@/services/team-aws";

/**
 * The team's SES standing, in the bar.
 *
 * It was a badge pinned to the bottom of the sidebar, where a status nobody
 * can act on from there sat under ten links nobody reads twice. Here it is
 * next to the team it describes, and it is a link: every state except
 * "production" is a thing to go and fix, so the pill goes to the page that
 * fixes it.
 *
 * Production is the quiet case and is drawn quietly — a dot and a word — since
 * a green badge shouting "correct" on every page is noise. On a narrow screen
 * only the mark survives; the label is the first thing to go, not the signal.
 */
export function SesPill({ status }: { status: TeamAws["sesAccountStatus"] }) {
  const spec =
    status === "production"
      ? {
          label: "Production",
          icon: <IconCheckCircle />,
          tone: "text-success/80",
          title: "SES is out of the sandbox: this team can send to anyone.",
        }
      : status === "requested"
        ? {
            label: "In review",
            icon: <IconClock />,
            tone: "text-warning",
            title: "AWS is reviewing the production access request.",
          }
        : status === "sandbox"
          ? {
              label: "Sandbox",
              icon: <IconAlert />,
              tone: "text-warning",
              title:
                "SES is in the sandbox: only verified addresses can receive mail.",
            }
          : {
              label: "No AWS",
              icon: <IconAlert />,
              tone: "text-white/50",
              title: "This team has no AWS connection, so nothing can send.",
            };

  return (
    <Link
      href="/app/settings/sending"
      title={spec.title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-white/10 py-1 pr-2.5 pl-2 text-xs no-underline transition-colors hover:border-white/25 hover:bg-white/5",
        spec.tone,
      )}
    >
      {spec.icon}
      <span className="hidden md:inline">{spec.label}</span>
      <span className="sr-only md:hidden">SES: {spec.label}</span>
    </Link>
  );
}
