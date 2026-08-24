import { eq } from "drizzle-orm";
import { TEAM_ROLES, type TeamRole } from "@sendsprite/shared";
import { db } from "@/db";
import { member, organization } from "@/db/schema";

export interface TeamContext {
  userId: string;
  team: { id: string; name: string; slug: string };
  role: TeamRole;
}

/**
 * Resolves the team a user should act in. Prefers the membership matching
 * `activeId`; if that id is stale (user removed, org deleted) falls back to
 * the oldest membership. Returns null when the user has no memberships.
 * Pure data access - no `next/*` - so it is integration-testable.
 */
export async function resolveTeam(
  userId: string,
  activeId: string | null,
): Promise<TeamContext | null> {
  const rows = await db()
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, userId))
    .orderBy(member.createdAt);
  const row =
    (activeId ? rows.find((r) => r.id === activeId) : undefined) ?? rows[0];
  if (!row) return null;
  const role: TeamRole = TEAM_ROLES.includes(row.role as TeamRole)
    ? (row.role as TeamRole)
    : "member";
  return { userId, team: { id: row.id, name: row.name, slug: row.slug }, role };
}
