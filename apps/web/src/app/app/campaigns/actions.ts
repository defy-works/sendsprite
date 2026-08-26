"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { CampaignBlock, CampaignStatus } from "@sendsprite/shared";
import { requestMeta } from "@/lib/audit";
import type { Result } from "@/lib/result";
import { requireTeam } from "@/lib/session";
import * as campaigns from "@/services/campaigns/crud";

export type { Result } from "@/lib/result";

/**
 * Server actions for the campaign editor. Thin by design, exactly as
 * `templates/actions.ts` is: resolve the actor, delegate, revalidate.
 *
 * Nothing here validates. `CreateCampaignInput`/`UpdateCampaignInput` run
 * inside the service on the way to the database, and the block contract runs
 * again inside `renderBlocks` on the way to the inbox — a check added here
 * would be a third set of rules to keep in step, and the first one to drift.
 *
 * Nothing here checks permissions either, for the same reason: `campaigns.*`
 * in `services/campaigns/crud.ts` checks `campaigns.manage` before it looks
 * anything up, so a member who reaches these functions directly (a server
 * action is a POST endpoint, not a button) gets the same refusal the UI shows.
 */
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

/** What the editor sends. Every field is validated again by the service. */
export interface CampaignDraft {
  name: string;
  bookId: string;
  domainId: string;
  from: string;
  /** `""` means "no reply-to", which the two paths express differently. */
  replyTo: string;
  subject: string;
  blocks: CampaignBlock[];
}

export async function createCampaign(
  draft: CampaignDraft,
): Promise<Result<{ id: string }>> {
  const res = await campaigns.createCampaign(await actor(), {
    ...draft,
    // Omitted rather than null: `CreateCampaignInput.replyTo` is `.optional()`,
    // and a null would be a validation error rather than "there isn't one".
    replyTo: draft.replyTo.trim() ? draft.replyTo : undefined,
  });
  if (!res.ok) return res;
  revalidatePath("/app/campaigns");
  return { ok: true, data: { id: res.data.id } };
}

export async function updateCampaign(
  id: string,
  draft: CampaignDraft,
): Promise<Result<{ status: CampaignStatus }>> {
  const res = await campaigns.updateCampaign(await actor(), id, {
    ...draft,
    // `null`, not `undefined`: on the update path clearing the field has to be
    // expressible, and `undefined` there means "leave it alone".
    replyTo: draft.replyTo.trim() ? draft.replyTo : null,
  });
  if (!res.ok) return res;
  revalidatePath(`/app/campaigns/${id}`);
  revalidatePath("/app/campaigns");
  // Read back off the row: saving an edit to a *scheduled* campaign reverts it
  // to `draft` and drops its send time, and the header has to say so.
  return { ok: true, data: { status: res.data.status } };
}

export async function deleteCampaign(id: string): Promise<Result> {
  const res = await campaigns.deleteCampaign(await actor(), id);
  if (res.ok) revalidatePath("/app/campaigns");
  return res;
}
