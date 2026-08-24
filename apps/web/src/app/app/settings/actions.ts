"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { TEAM_ROLES, type TeamRole } from "@sendsprite/shared";
import { requireTeam } from "@/lib/session";
import * as team from "@/services/team";

export type { Result } from "@/services/team";

/** Server actions are thin: resolve the actor, delegate, revalidate. */
async function actor() {
  const ctx = await requireTeam();
  return {
    actor: {
      userId: ctx.userId,
      teamId: ctx.team.id,
      teamName: ctx.team.name,
      role: ctx.role,
    },
    headers: await headers(),
  };
}

export async function renameTeam(formData: FormData) {
  const { actor: a, headers: h } = await actor();
  const res = await team.renameTeam(a, h, formData.get("name"));
  if (res.ok) revalidatePath("/app", "layout");
  return res;
}

export async function inviteMember(formData: FormData) {
  const { actor: a, headers: h } = await actor();
  const res = await team.inviteMember(
    a,
    h,
    formData.get("email"),
    formData.get("role"),
  );
  if (res.ok) revalidatePath("/app/settings");
  return res;
}

export async function cancelInvitation(invitationId: string) {
  const { actor: a, headers: h } = await actor();
  const res = await team.cancelInvitation(a, h, invitationId);
  if (res.ok) revalidatePath("/app/settings");
  return res;
}

export async function removeMember(memberId: string) {
  const { actor: a, headers: h } = await actor();
  const res = await team.removeMember(a, h, memberId);
  if (res.ok) revalidatePath("/app/settings");
  return res;
}

export async function changeRole(memberId: string, role: string) {
  // Arguments arrive from the client untyped: narrow before delegating.
  if (!TEAM_ROLES.includes(role as TeamRole))
    return { ok: false as const, error: "Unknown role." };
  const { actor: a, headers: h } = await actor();
  const res = await team.changeRole(a, h, memberId, role as TeamRole);
  if (res.ok) revalidatePath("/app/settings");
  return res;
}
