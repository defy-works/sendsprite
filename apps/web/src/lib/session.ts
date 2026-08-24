import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq, and } from "drizzle-orm";
import type { TeamRole } from "@sendsprite/shared";
import { auth } from "./auth";
import { db } from "@/db";
import { member, organization } from "@/db/schema";

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

/** Redirects to /login when unauthenticated. */
export async function requireSession() {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

export interface TeamContext {
  userId: string;
  team: { id: string; name: string; slug: string };
  role: TeamRole;
}

/** Resolves the active team; if the user has none, sends them to create one. */
export async function requireTeam(): Promise<TeamContext> {
  const s = await requireSession();
  const activeId = s.session.activeOrganizationId ?? null;
  const rows = await db()
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(
      activeId
        ? and(eq(member.userId, s.user.id), eq(organization.id, activeId))
        : eq(member.userId, s.user.id),
    )
    .limit(1);
  const row = rows[0];
  if (!row) redirect("/teams/new");
  return {
    userId: s.user.id,
    team: { id: row.id, name: row.name, slug: row.slug },
    role: row.role as TeamRole,
  };
}
