import { z } from "zod";
import { eq } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { can, type Action, type TeamRole } from "@sendsprite/shared";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { invitation } from "@/db/schema";
import { computeDiff, recordAudit, type RequestMeta } from "@/lib/audit";
// Not `@/env`: that module is `server-only` and throws under vitest.
import { loadEnv } from "@/env.schema";

export type Result<T = undefined> =
  { ok: true; data: T } | { ok: false; error: string };

/** The slice of `TeamContext` the team mutations need. No `next/*` here. */
export interface TeamActor {
  userId: string;
  teamId: string;
  teamName: string;
  role: TeamRole;
  /** Client ip / UA for the audit row; absent outside a request. */
  meta?: RequestMeta;
}

const DENIED: Result<never> = {
  ok: false,
  error: "You don't have permission to do that.",
};

/**
 * Runs `fn` when the actor holds `action`; better-auth's own permission
 * errors (APIError) surface as a Result instead of throwing.
 */
async function authorized<T>(
  actor: TeamActor,
  action: Action,
  fn: () => Promise<Result<T>>,
): Promise<Result<T>> {
  if (!can(actor.role, action)) return DENIED;
  try {
    return await fn();
  } catch (err) {
    if (err instanceof APIError)
      return { ok: false, error: err.message || "Request failed." };
    throw err;
  }
}

export function renameTeam(
  actor: TeamActor,
  headers: Headers,
  rawName: unknown,
): Promise<Result> {
  return authorized(actor, "team.rename", async () => {
    const name = z.string().trim().min(2).max(64).safeParse(rawName);
    if (!name.success)
      return { ok: false, error: "Name must be 2–64 characters." };
    await auth.api.updateOrganization({
      headers,
      body: { organizationId: actor.teamId, data: { name: name.data } },
    });
    await recordAudit({
      teamId: actor.teamId,
      actorUserId: actor.userId,
      ...actor.meta,
      action: "team.rename",
      targetType: "team",
      targetId: actor.teamId,
      diff: computeDiff({ name: actor.teamName }, { name: name.data }),
    });
    return { ok: true, data: undefined };
  });
}

// Invitation lookup on signup matches by lowercased email (lib/auth.ts).
const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: z.enum(["admin", "member"]),
});

export function inviteMember(
  actor: TeamActor,
  headers: Headers,
  email: unknown,
  role: unknown,
): Promise<Result<{ link: string }>> {
  return authorized(actor, "members.invite", async () => {
    const parsed = inviteSchema.safeParse({ email, role });
    if (!parsed.success)
      return { ok: false, error: "Enter a valid email and role." };
    const inv = await auth.api.createInvitation({
      headers,
      body: {
        organizationId: actor.teamId,
        email: parsed.data.email,
        role: parsed.data.role,
      },
    });
    await recordAudit({
      teamId: actor.teamId,
      actorUserId: actor.userId,
      ...actor.meta,
      action: "members.invite",
      targetType: "invitation",
      targetId: inv.id,
      diff: {
        email: { to: parsed.data.email },
        role: { to: parsed.data.role },
      },
    });
    return {
      ok: true,
      data: { link: `${loadEnv().APP_URL}/invite/${inv.id}` },
    };
  });
}

export function cancelInvitation(
  actor: TeamActor,
  headers: Headers,
  invitationId: string,
): Promise<Result> {
  return authorized(actor, "members.invite", async () => {
    // better-auth authorizes against the invitation's own org, so an admin
    // of another team could cancel by id. Scope to the actor's team first.
    const [inv] = await db()
      .select({ organizationId: invitation.organizationId })
      .from(invitation)
      .where(eq(invitation.id, invitationId))
      .limit(1);
    if (!inv || inv.organizationId !== actor.teamId)
      return { ok: false, error: "Invitation not found." };
    await auth.api.cancelInvitation({ headers, body: { invitationId } });
    await recordAudit({
      teamId: actor.teamId,
      actorUserId: actor.userId,
      ...actor.meta,
      action: "members.invite.cancel",
      targetType: "invitation",
      targetId: invitationId,
    });
    return { ok: true, data: undefined };
  });
}

export function removeMember(
  actor: TeamActor,
  headers: Headers,
  memberIdOrEmail: string,
): Promise<Result> {
  return authorized(actor, "members.remove", async () => {
    await auth.api.removeMember({
      headers,
      body: { organizationId: actor.teamId, memberIdOrEmail },
    });
    await recordAudit({
      teamId: actor.teamId,
      actorUserId: actor.userId,
      ...actor.meta,
      action: "members.remove",
      targetType: "member",
      targetId: memberIdOrEmail,
    });
    return { ok: true, data: undefined };
  });
}

export function changeRole(
  actor: TeamActor,
  headers: Headers,
  memberId: string,
  role: TeamRole,
): Promise<Result> {
  return authorized(actor, "members.changeRole", async () => {
    if (role === "owner" && actor.role !== "owner")
      return { ok: false, error: "Only an owner can promote to owner." };
    await auth.api.updateMemberRole({
      headers,
      body: { organizationId: actor.teamId, memberId, role },
    });
    await recordAudit({
      teamId: actor.teamId,
      actorUserId: actor.userId,
      ...actor.meta,
      action: "members.changeRole",
      targetType: "member",
      targetId: memberId,
      diff: { role: { to: role } },
    });
    return { ok: true, data: undefined };
  });
}
