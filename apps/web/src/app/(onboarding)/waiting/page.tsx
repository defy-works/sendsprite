import { redirect } from "next/navigation";
import { requireTeam } from "@/lib/session";
import { SignOutLink } from "@/components/app/SignOutLink";
import { listTeamAdminEmails } from "@/lib/team";
import { getTeamSettings } from "@/services/team-settings";

export const metadata = { title: "Waiting for setup" };

export default async function WaitingPage() {
  const ctx = await requireTeam();
  const team = await getTeamSettings(ctx.team.id);
  if (team?.setupCompleted) redirect("/app");
  if (ctx.role === "owner" || ctx.role === "admin") redirect("/setup");
  const owners = await listTeamAdminEmails(ctx.team.id);
  return (
    <main className="grid-hairlines flex min-h-dvh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="glass-strong p-8">
          <p className="num-stamp">Almost there</p>
          <h1 className="mt-4 text-lg font-medium">
            An admin is connecting this team&apos;s AWS account.
          </h1>
          <p className="mt-2 text-sm text-white/65">
            You&apos;ll be able to use Sendsprite once they&apos;re done.
            Refresh in a minute, or nudge one of them:
          </p>
          {owners.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1 text-sm">
              {owners.map((e) => (
                <li key={e}>
                  <a className="text-indigo-300" href={`mailto:${e}`}>
                    {e}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* The other dead end: this page waits on somebody else, so leaving is
          the only thing the person reading it can actually do. */}
        <p className="text-center text-sm text-white/45">
          Wrong account? <SignOutLink />
        </p>
      </div>
    </main>
  );
}
