"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { TEAM_ROLES, type TeamRole } from "@sendsprite/shared";
import { requestMeta } from "@/lib/audit";
import { requireTeam } from "@/lib/session";
import { clearActiveOrganization } from "@/lib/team";
import * as team from "@/services/team";
import { deleteTeam, type DeleteTeamOutcome } from "@/services/team-delete";
import { setTeamRetention } from "@/services/team-settings";

import type { Result } from "@/lib/result";

export type { Result } from "@/services/team";

/** Server actions are thin: resolve the actor, delegate, revalidate. */
async function actor() {
  const ctx = await requireTeam();
  const h = await headers();
  return {
    actor: {
      userId: ctx.userId,
      teamId: ctx.team.id,
      teamName: ctx.team.name,
      role: ctx.role,
      meta: requestMeta(h),
    },
    headers: h,
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

const retentionForm = z.object({
  retentionDays: z.coerce
    .number({ error: "Retention days must be a number." })
    .int("Retention days must be a whole number.")
    .min(1, "Retention days must be at least 1.")
    .max(3650, "Retention days must be at most 3650."),
});

/** Team's own retention window; clamped to the instance ceiling on write. */
export async function updateRetentionAction(fd: FormData) {
  const { actor: a } = await actor();
  const parsed = retentionForm.safeParse({
    retentionDays: fd.get("retentionDays"),
  });
  if (!parsed.success)
    return {
      ok: false as const,
      error: parsed.error.issues[0]?.message ?? "Check the form.",
    };
  const res = await setTeamRetention(a, parsed.data.retentionDays);
  if (res.ok) revalidatePath("/app/settings");
  return res;
}

/**
 * Deletes the active team and everything under it.
 *
 * The service does the refusing (owner only, no live send, no live
 * subscription) and the third-party teardown; this only has to make sure the
 * session is not left pointing at an organization that no longer exists.
 * better-auth stores `activeOrganizationId` on the session row, and the row
 * survives the cascade, so without clearing it every subsequent request
 * resolves a dead team. `resolveTeam` falls back to the oldest remaining
 * membership when the active id resolves to nothing, so clearing it is enough
 * — the caller then navigates and the layout picks the next team, or sends
 * them to /teams/new when that was the last one.
 */
export async function deleteTeamAction(): Promise<Result<DeleteTeamOutcome>> {
  const { actor: a } = await actor();
  const res = await deleteTeam(a, { fetch: globalThis.fetch });
  if (!res.ok) return res;
  await clearActiveOrganization(a.userId, a.teamId);
  revalidatePath("/app", "layout");
  return res;
}
