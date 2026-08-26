"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireTeam } from "@/lib/session";
import { requestMeta } from "@/lib/audit";
import * as domains from "@/services/domains";
import { enqueue } from "@/jobs/enqueue";

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

export async function createDomain(fd: FormData) {
  const res = await domains.createDomain(
    await actor(),
    { name: fd.get("name") },
    { enqueue },
  );
  if (res.ok) revalidatePath("/app/domains");
  return res;
}

export async function reverifyDomain(id: string) {
  const res = await domains.reverifyDomain(await actor(), id, { enqueue });
  revalidatePath(`/app/domains/${id}`);
  return res;
}

export async function retryProvisioning(id: string) {
  const res = await domains.retryProvisioning(await actor(), id, { enqueue });
  revalidatePath(`/app/domains/${id}`);
  return res;
}

export async function deleteDomain(id: string) {
  const res = await domains.deleteDomain(await actor(), id, {});
  if (res.ok) revalidatePath("/app/domains");
  return res;
}
