"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireTeam } from "@/lib/session";
import { requestMeta } from "@/lib/audit";
import type { Result } from "@/lib/result";
import * as suppressions from "@/services/suppressions";

export type { Result } from "@/lib/result";

/** Server actions are thin: resolve the actor, delegate, revalidate. */
async function actor() {
  const ctx = await requireTeam();
  return {
    userId: ctx.userId,
    teamId: ctx.team.id,
    teamName: ctx.team.name,
    role: ctx.role,
    meta: requestMeta(await headers()),
  };
}

export async function addSuppression(fd: FormData): Promise<Result> {
  const res = await suppressions.addSuppression(await actor(), {
    email: fd.get("email"),
    reason: fd.get("reason"),
    // An empty input arrives as ""; the shared schema has no transforms
    // (OpenAPI), so unset is decided here.
    note: fd.get("note") || undefined,
  });
  if (!res.ok) return res;
  revalidatePath("/app/suppressions");
  return { ok: true, data: undefined }; // the row itself is not needed client-side
}

export async function removeSuppression(email: string): Promise<Result> {
  const res = await suppressions.removeSuppression(await actor(), email);
  if (res.ok) revalidatePath("/app/suppressions");
  return res;
}
