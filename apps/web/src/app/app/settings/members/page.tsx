import { and, eq, gt } from "drizzle-orm";
import { can } from "@sendsprite/shared";
import { db } from "@/db";
import { invitation, member, user } from "@/db/schema";
import { requireTeam } from "@/lib/session";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { MembersPanel } from "../MembersPanel";
import { InvitePanel } from "../InvitePanel";

export const metadata = { title: "Members" };

// Server-side formatting: a locale/timezone-dependent toLocaleDateString in a
// client component would hydrate differently from the SSR markup.
const formatDate = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);

/** Who is on the team, and who has been asked to be. */
export default async function MembersSettingsPage() {
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
    <div className="flex max-w-3xl flex-col gap-8">
      <PageHeader
        title="Members"
        description="Everyone with access to this team, and the invitations still outstanding."
      />
      <Card>
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
