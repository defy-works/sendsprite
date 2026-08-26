import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { IconAlert, IconArrowRight, IconClock } from "@/components/ui/icons";
import type { TeamAws } from "@/services/team-aws";

/**
 * What the dashboard says when the team can be reached but cannot yet send.
 *
 * This is the other half of letting people out of the setup wizard. The wizard
 * used to be a wall precisely because nothing downstream said anything when it
 * was skipped — a domain page that fails to provision with no explanation is
 * worse than a wall. So the escape hatch comes with a standing, specific
 * reminder that names what is missing and links straight at it.
 *
 * Nothing is shown once the team is in SES production: a banner that is always
 * there is a banner nobody reads.
 */
export function SetupBanner({
  awsConnected,
  sesStatus,
  canSetUp,
  suspension,
}: {
  awsConnected: boolean;
  sesStatus: TeamAws["sesAccountStatus"];
  canSetUp: boolean;
  /** Set by an instance admin; outranks anything about setup. */
  suspension?: { reason: string | null } | null;
}) {
  // A suspended team is not a team with a configuration problem, and telling
  // them to connect AWS when an operator has switched them off would send
  // them down an hour of the wrong diagnosis.
  if (suspension)
    return (
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-danger/45 bg-danger/12 px-4 py-3">
        <span className="text-lg text-red-300">
          <IconAlert />
        </span>
        <div className="min-w-56 flex-1">
          <p className="text-sm font-medium">Sending is suspended</p>
          <p className="text-xs text-white/70">
            {suspension.reason ??
              "The operator of this instance has suspended sending for this team. Everything else still works."}
          </p>
        </div>
      </div>
    );

  if (awsConnected && sesStatus === "production") return null;

  const blocking = !awsConnected;
  const { title, body } = blocking
    ? {
        title: "This team cannot send yet",
        body: "Nothing leaves until an AWS account is connected — domains will not verify and campaigns will not queue.",
      }
    : sesStatus === "requested"
      ? {
          title: "SES production access is under review",
          body: "Until AWS grants it you can only send to addresses you have verified, 200 a day.",
        }
      : {
          title: "SES is in the sandbox",
          body: "You can only send to addresses you have verified, 200 a day. Request production access to lift both limits.",
        };

  return (
    <div
      className={[
        "mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border px-4 py-3",
        blocking
          ? "border-danger/40 bg-danger/10"
          : "border-warning/35 bg-warning/8",
      ].join(" ")}
    >
      <span
        className={blocking ? "text-lg text-red-300" : "text-lg text-amber-300"}
      >
        {sesStatus === "requested" ? <IconClock /> : <IconAlert />}
      </span>
      <div className="min-w-56 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-white/60">{body}</p>
      </div>
      {canSetUp && sesStatus !== "requested" && (
        <Button
          asChild
          size="sm"
          variant={blocking ? "primary" : "subtle"}
          className="shrink-0"
        >
          <Link href="/app/settings#sending">
            {blocking ? "Connect AWS" : "Request access"}
            <IconArrowRight className="text-xs" />
          </Link>
        </Button>
      )}
    </div>
  );
}
