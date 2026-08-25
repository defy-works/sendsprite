import { redirect } from "next/navigation";
import { requireTeam } from "@/lib/session";
import { listOwnerEmails } from "@/lib/team";
import { getInstanceSettings } from "@/services/instance-settings";

export const metadata = { title: "Waiting for setup" };

export default async function WaitingPage() {
  const ctx = await requireTeam();
  const settings = await getInstanceSettings();
  if (settings.setupCompleted) redirect("/app");
  if (ctx.role === "owner") redirect("/setup");
  const owners = await listOwnerEmails();
  return (
    <main className="grid-hairlines flex min-h-dvh items-center justify-center p-6">
      <div className="glass-strong w-full max-w-sm p-8">
        <p className="num-stamp">Almost there</p>
        <h1 className="mt-4 text-lg font-medium">
          An owner is finishing setup.
        </h1>
        <p className="mt-2 text-sm text-white/65">
          Sendsprite needs an AWS connection before anyone can use it. Refresh
          in a minute, or nudge an owner:
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
    </main>
  );
}
