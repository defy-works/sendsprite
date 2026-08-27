import { eq } from "drizzle-orm";
import { can } from "@sendsprite/shared";
import { db } from "@/db";
import { member } from "@/db/schema";
import { requireTeam } from "@/lib/session";
import { getInstanceSettings } from "@/services/instance-settings";
import { getTeamSettings } from "@/services/team-settings";
import { effectiveRetentionDays } from "@/services/retention-policy";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { RenameForm } from "./RenameForm";
import { RetentionForm } from "./RetentionForm";
import { DangerZone } from "./DangerZone";

export const metadata = { title: "Settings" };

/**
 * General: what the team is called, how long its mail log is kept, and how to
 * delete it.
 *
 * Settings was one long page with an in-page rail, on the argument that
 * Sending, Retention and Members are read together. They are not — each is
 * opened to change one thing — and the cost was a page that grew a second
 * navigation column beside the app's own. The sections are routes now, listed
 * under Settings in the sidebar.
 *
 * Retention and the danger zone stay here rather than getting rows of their
 * own: a retention policy is one number and deleting the team is one button,
 * and both are facts about this team's own record rather than about the people
 * on it or the account it sends through. Members, Sending and Billing each
 * carry enough to be worth a page.
 */
export default async function SettingsPage() {
  const ctx = await requireTeam();
  const [instance, settings, memberCount] = await Promise.all([
    getInstanceSettings(),
    getTeamSettings(ctx.team.id),
    db().$count(member, eq(member.organizationId, ctx.team.id)),
  ]);

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <PageHeader
        title="Settings"
        description="This team: what it is called, how long its mail log is kept, and how to close it."
      />

      <Card>
        <CardHeader>
          <CardTitle>Team</CardTitle>
        </CardHeader>
        <CardBody>
          {/* Keyed on the name so a successful rename resets the field's defaultValue. */}
          <RenameForm
            key={ctx.team.name}
            name={ctx.team.name}
            disabled={!can(ctx.role, "team.rename")}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Retention</CardTitle>
        </CardHeader>
        <CardBody>
          <RetentionForm
            retentionDays={effectiveRetentionDays(
              settings?.retentionDays ?? null,
              instance.retentionDays,
            )}
            instanceMax={instance.retentionDays}
            canManage={can(ctx.role, "settings.manage")}
          />
        </CardBody>
      </Card>

      {ctx.role === "owner" && (
        <div className="flex flex-col gap-4">
          <h2 className="text-base font-medium">Danger zone</h2>
          <div className="rounded-lg border border-danger/35 bg-danger/6 p-5">
            <DangerZone
              teamName={ctx.team.name}
              isOwner
              memberCount={Number(memberCount)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
