import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { requireTeam } from "@/lib/session";
import { getInstanceSettings } from "@/services/instance-settings";
import { AppShell } from "@/components/app/AppShell";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireTeam();
  const settings = await getInstanceSettings();
  // Until an owner finishes the wizard the dashboard is closed: owners go
  // set it up, everyone else waits (both routes live outside this layout).
  if (!settings.setupCompleted)
    redirect(ctx.role === "owner" ? "/setup" : "/waiting");
  return (
    <AppShell
      teamId={ctx.team.id}
      teamName={ctx.team.name}
      email={ctx.session.user.email}
      sesStatus={settings.sesAccountStatus}
    >
      {children}
    </AppShell>
  );
}
