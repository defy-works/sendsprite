import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { loadEnv } from "@/env.schema";
import { requireTeam } from "@/lib/session";
import { isInstanceAdmin, parseAdminEmails } from "@/lib/instance-admin";
import { teamSuspension } from "@/services/send-limits";
import { getTeamAws } from "@/services/team-aws";
import { getTeamSettings } from "@/services/team-settings";
import { billingConfig } from "@/services/billing/config";
import { AppShell } from "@/components/app/AppShell";
import { SetupBanner } from "@/components/app/SetupBanner";
import { settingsSections } from "./settings/sections";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireTeam();
  const team = await getTeamSettings(ctx.team.id);
  const canSetUp = ctx.role === "owner" || ctx.role === "admin";
  // The wizard is shown once, not enforced for ever. `setupCompleted` means
  // "this team has been through (or dismissed) the wizard" — it is not a claim
  // that AWS is connected, which is why the banner below reads `aws` instead.
  // Trapping somebody on /setup with no way back was the old behaviour and it
  // had no upside: an admin who wants to look at Settings or invite a
  // colleague before connecting AWS is doing something reasonable.
  if (!team?.setupCompleted) redirect(canSetUp ? "/setup" : "/waiting");
  const [aws, suspension] = await Promise.all([
    getTeamAws(ctx.team.id),
    teamSuspension(ctx.team.id),
  ]);
  return (
    <AppShell
      teamId={ctx.team.id}
      teamName={ctx.team.name}
      email={ctx.session.user.email}
      name={ctx.session.user.name || null}
      sesStatus={aws?.sesAccountStatus ?? null}
      settingsChildren={settingsSections({
        role: ctx.role,
        billingEnabled: billingConfig().enabled,
      })}
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
      <SetupBanner
        awsConnected={aws !== null}
        sesStatus={aws?.sesAccountStatus ?? null}
        canSetUp={canSetUp}
        suspension={suspension}
      />
      {children}
    </AppShell>
  );
}
