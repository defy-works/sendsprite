"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireTeam } from "@/lib/session";
import { requestMeta } from "@/lib/audit";
import * as keys from "@/services/api-keys";

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

export async function createApiKey(fd: FormData) {
  const res = await keys.createApiKey(await actor(), {
    name: fd.get("name"),
    permission: fd.get("permission"),
    domainId: fd.get("domainId"),
  });
  if (res.ok) revalidatePath("/app/api-keys");
  return res;
}

export async function revokeApiKey(id: string) {
  const res = await keys.revokeApiKey(await actor(), id);
  if (res.ok) revalidatePath("/app/api-keys");
  return res;
}
