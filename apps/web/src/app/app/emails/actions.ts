"use server";
import { revalidatePath } from "next/cache";
import { can } from "@sendsprite/shared";
import { requireTeam } from "@/lib/session";
import type { Result } from "@/lib/result";
import { enqueue } from "@/jobs/enqueue";
import * as emails from "@/services/emails";

export type { Result };

const DENIED: Result<never> = {
  ok: false,
  error: "You don't have permission to do that.",
};

/** Server actions are thin: check the role, delegate, revalidate. */
export async function resendEmail(id: string): Promise<Result<{ id: string }>> {
  const ctx = await requireTeam();
  if (!can(ctx.role, "emails.send")) return DENIED;
  const res = await emails.resendEmail(
    {
      teamId: ctx.team.id,
      source: "dashboard",
      apiKeyId: null,
      actorUserId: ctx.userId,
      keyDomainId: null,
    },
    id,
    { enqueue },
  );
  if (!res.ok) return { ok: false, error: res.error, code: res.code };
  revalidatePath("/app/emails");
  return { ok: true, data: { id: res.data.id } };
}

export async function cancelEmail(id: string): Promise<Result> {
  const ctx = await requireTeam();
  if (!can(ctx.role, "emails.send")) return DENIED;
  const res = await emails.cancelEmail(ctx.team.id, id, ctx.userId);
  if (!res.ok) return { ok: false, error: res.error, code: res.code };
  revalidatePath(`/app/emails/${id}`);
  return { ok: true, data: undefined };
}
