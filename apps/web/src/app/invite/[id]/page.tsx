import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { invitation, organization } from "@/db/schema";
import { getSession } from "@/lib/session";
import { AcceptInvite } from "./AcceptInvite";

export default async function InvitePage(props: PageProps<"/invite/[id]">) {
  const { id } = await props.params;
  const [inv] = await db()
    .select({
      id: invitation.id,
      email: invitation.email,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      team: organization.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(invitation.organizationId, organization.id))
    .where(eq(invitation.id, id))
    .limit(1);
  const session = await getSession();
  if (!session) redirect(`/signup?next=${encodeURIComponent(`/invite/${id}`)}`);
  const valid = Boolean(
    inv && inv.status === "pending" && inv.expiresAt > new Date(),
  );
  return (
    <main className="grid-hairlines flex min-h-dvh items-center justify-center p-6">
      <div className="glass-strong w-full max-w-sm p-8">
        <p className="num-stamp">Invitation</p>
        {!valid ? (
          <p className="mt-4 text-sm text-white/70">
            This invitation is invalid or has expired.
          </p>
        ) : (
          <AcceptInvite
            invitationId={id}
            teamName={inv!.team}
            invitedEmail={inv!.email}
            currentEmail={session.user.email}
          />
        )}
      </div>
    </main>
  );
}
