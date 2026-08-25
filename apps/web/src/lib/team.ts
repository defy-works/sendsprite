import { and, eq, inArray } from "drizzle-orm";
import { TEAM_ROLES, type TeamRole } from "@sendsprite/shared";
import { db } from "@/db";
import { member, organization, user } from "@/db/schema";
import type { auth } from "./auth";

export type Session = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>;

export interface ResolvedTeam {
  userId: string;
  team: { id: string; name: string; slug: string };
  role: TeamRole;
}

/** What `requireTeam()` hands to pages: the team plus the session it came from. */
export interface TeamContext extends ResolvedTeam {
  session: Session;
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
): Promise<ResolvedTeam | null> {
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

/**
 * Owner emails to show a member waiting on setup: owners of the caller's
 * own teams first; only when none exist (e.g. the caller's team has no owner
 * left) every owner on the instance.
 */
export async function listOwnerEmails(userId: string): Promise<string[]> {
  const mine = db()
    .select({ id: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId));
  const query = (scoped: boolean) =>
    db()
      .selectDistinct({ email: user.email })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(
        scoped
          ? and(eq(member.role, "owner"), inArray(member.organizationId, mine))
          : eq(member.role, "owner"),
      )
      .orderBy(user.email);
  const rows = await query(true);
  const all = rows.length > 0 ? rows : await query(false);
  return all.map((r) => r.email);
}
