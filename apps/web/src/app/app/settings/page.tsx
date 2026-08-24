import { and, eq, gt } from "drizzle-orm";
import { can } from "@sendsprite/shared";
import { db } from "@/db";
import { invitation, member, user } from "@/db/schema";
import { requireTeam } from "@/lib/session";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { RenameForm } from "./RenameForm";
import { MembersPanel } from "./MembersPanel";
import { InvitePanel } from "./InvitePanel";

export const metadata = { title: "Settings" };

// Server-side formatting: a locale/timezone-dependent toLocaleDateString in a
// client component would hydrate differently from the SSR markup.
const formatDate = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);

export default async function SettingsPage() {
  const ctx = await requireTeam();
  const members = await db()
    .select({
      id: member.id,
      userId: member.userId,
      role: member.role,
      email: user.email,
      name: user.name,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, ctx.team.id))
    .orderBy(member.createdAt);
  const invites = (
    await db()
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, ctx.team.id),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, new Date()),
        ),
      )
      .orderBy(invitation.expiresAt)
  ).map(({ expiresAt, ...i }) => ({ ...i, expires: formatDate(expiresAt) }));
  return (
    <div className="flex max-w-3xl flex-col gap-6">
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
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardBody>
          <MembersPanel members={members} me={ctx.userId} myRole={ctx.role} />
        </CardBody>
      </Card>
      {can(ctx.role, "members.invite") && (
        <Card>
          <CardHeader>
            <CardTitle>Invitations</CardTitle>
          </CardHeader>
          <CardBody>
            <InvitePanel invites={invites} />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
