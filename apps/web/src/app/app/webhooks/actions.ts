"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireTeam } from "@/lib/session";
import { requestMeta } from "@/lib/audit";
import { enqueue } from "@/jobs/enqueue";
import * as webhooks from "@/services/webhooks";

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

export async function createWebhook(fd: FormData) {
  const res = await webhooks.createWebhook(await actor(), {
    url: fd.get("url"),
    events: fd.getAll("events"),
  });
  if (res.ok) revalidatePath("/app/webhooks");
  return res;
}

export async function setWebhookEnabled(id: string, enabled: boolean) {
  const res = await webhooks.updateWebhook(await actor(), id, { enabled });
  if (res.ok) revalidatePath(`/app/webhooks/${id}`);
  return res.ok ? { ok: true as const, data: undefined } : res;
}

export async function deleteWebhook(id: string) {
  const res = await webhooks.deleteWebhook(await actor(), id);
  if (res.ok) revalidatePath("/app/webhooks");
  return res;
}

export async function rotateSecret(id: string) {
  return webhooks.rotateSecret(await actor(), id);
}

export async function sendTestEvent(id: string) {
  const res = await webhooks.sendTestEvent(await actor(), id, { enqueue });
  if (res.ok) revalidatePath(`/app/webhooks/${id}`);
  return res;
}

export async function replayDelivery(webhookId: string, deliveryId: string) {
  const res = await webhooks.replayDelivery(await actor(), deliveryId, {
    enqueue,
  });
  if (res.ok) revalidatePath(`/app/webhooks/${webhookId}`);
  return res;
}
