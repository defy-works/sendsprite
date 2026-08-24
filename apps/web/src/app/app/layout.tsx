import type { ReactNode } from "react";
import { requireTeam } from "@/lib/session";
import { getInstanceSettings } from "@/services/instance-settings";
import { AppShell } from "@/components/app/AppShell";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireTeam();
  const settings = await getInstanceSettings();
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
