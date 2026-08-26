import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { loadEnv } from "@/env.schema";
import { requireTeam } from "@/lib/session";
import { isInstanceAdmin, parseAdminEmails } from "@/lib/instance-admin";
import { getTeamAws } from "@/services/team-aws";
import { getTeamSettings } from "@/services/team-settings";
import { AppShell } from "@/components/app/AppShell";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireTeam();
  const team = await getTeamSettings(ctx.team.id);
  // Until this team connects its own AWS account the dashboard is closed:
  // owners and admins go set it up, everyone else waits (both routes live
  // outside this layout).
  if (!team?.setupCompleted)
    redirect(
      ctx.role === "owner" || ctx.role === "admin" ? "/setup" : "/waiting",
    );
  const aws = await getTeamAws(ctx.team.id);
  return (
    <AppShell
      teamId={ctx.team.id}
      teamName={ctx.team.name}
      email={ctx.session.user.email}
      sesStatus={aws?.sesAccountStatus ?? null}
      isInstanceAdmin={isInstanceAdmin(
        {
          email: ctx.session.user.email,
          flag:
            (ctx.session.user as { instanceAdmin?: boolean }).instanceAdmin ===
            true,
        },
        parseAdminEmails(loadEnv().INSTANCE_ADMIN_EMAILS),
      )}
    >
      {children}
    </AppShell>
  );
}
