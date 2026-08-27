import { and, eq, inArray } from "drizzle-orm";
import { TEAM_ROLES, type TeamRole } from "@sendsprite/shared";
import { db } from "@/db";
import { member, organization, session as sessions, user } from "@/db/schema";
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
 * Owner and admin emails to show a member waiting on setup — for **their own
 * team only**. The instance-wide fallback is gone: with AWS on the team, an
 * owner of an unrelated team cannot finish your setup, so listing them just
 * sends the member to the wrong person.
 */
export async function listTeamAdminEmails(teamId: string): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ email: user.email })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(
      and(
        eq(member.organizationId, teamId),
        inArray(member.role, ["owner", "admin"]),
      ),
    )
    .orderBy(user.email);
  return rows.map((r) => r.email);
}

/**
 * Blanks `active_organization_id` on every session of a user that still points
 * at a team that has just been deleted.
 *
 * `resolveTeam` already tolerates a stale id, so this is not what keeps the
 * dashboard working — better-auth is. Its organization plugin reads the same
 * column for `setActive`, `useListOrganizations` and the invitation endpoints,
 * and a session claiming membership of a row that no longer exists is a
 * disagreement between two readers of one column. Cheaper to clear it than to
 * reason about which of them notices.
 *
 * Every session, not just the current one: the same person may be signed in on
 * a phone, and that session would otherwise carry the dead id until it
 * expires.
 */
export async function clearActiveOrganization(userId: string, teamId: string) {
  await db()
    .update(sessions)
    .set({ activeOrganizationId: null })
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.activeOrganizationId, teamId),
      ),
    );
}
