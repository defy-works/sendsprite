"use server";
import { headers } from "next/headers";
import {
  can,
  type CampaignBlock,
  type CampaignTheme,
} from "@sendsprite/shared";
import { requestMeta } from "@/lib/audit";
import { requireTeam } from "@/lib/session";
import type { Result } from "@/lib/result";
import * as layouts from "@/services/layouts";

/**
 * Saved layouts, for both editors.
 *
 * In `campaigns/` because that is where the block editor lives, and imported
 * by the template editor rather than duplicated — a layout is blocks, and both
 * editors edit blocks.
 *
 * Gated on `campaigns.manage`, which is the permission that already means "may
 * author a body on this team". A member who cannot write a campaign should not
 * be able to leave a footer with the wrong address in it for everyone who can.
 */
async function actor() {
  const ctx = await requireTeam();
  return {
    userId: ctx.userId,
    teamId: ctx.team.id,
    role: ctx.role,
    meta: requestMeta(await headers()),
  };
}

const DENIED: Result<never> = {
  ok: false,
  error: "Saving a layout needs the admin role.",
};

export async function listLayoutsAction(): Promise<
  Result<layouts.SavedLayout[]>
> {
  const a = await actor();
  return { ok: true, data: await layouts.listLayouts(a.teamId) };
}

export async function saveLayoutAction(input: {
  name: string;
  blocks: CampaignBlock[];
  theme: CampaignTheme | null;
}): Promise<Result<layouts.SavedLayout>> {
  const a = await actor();
  if (!can(a.role, "campaigns.manage")) return DENIED;
  return layouts.saveLayout(a, input);
}

export async function deleteLayoutAction(id: string): Promise<Result> {
  const a = await actor();
  if (!can(a.role, "campaigns.manage")) return DENIED;
  return layouts.deleteLayout(a, id);
}
