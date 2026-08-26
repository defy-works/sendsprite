import { keyActor } from "@/lib/api-auth";
import {
  fail,
  noContent,
  ok,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import {
  deleteCampaign,
  getCampaign,
  publicCampaign,
  updateCampaign,
} from "@/services/campaigns/crud";

export const dynamic = "force-dynamic";

/**
 * One campaign.
 *
 * The bare row, not the dashboard's joined view: `CampaignObject` declares
 * `bookId`/`domainId` as ids, and a REST client that wants the book's name
 * asks `GET /contact-books/{id}` for it. Full keys only (`../route.ts` says
 * why).
 */
export const GET = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const c = await getCampaign(auth.team.id, id ?? "");
    if (!c) return fail("not_found", "Campaign not found.");
    return ok(publicCampaign(c));
  },
  { permission: "full" },
);

/**
 * Partial update, refused with a `409` unless the campaign is `draft` or
 * `scheduled`.
 *
 * Editing a `scheduled` campaign reverts it to `draft` and clears its time,
 * so an unreviewed change cannot ship on the old timer; re-arming is an
 * explicit `POST /campaigns/{id}/schedule`. An update that changes nothing
 * does neither, which is what makes a re-save of an unchanged body safe.
 */
export const PATCH = withApiKey(
  async (req, auth, ctx) => {
    const { id } = await ctx.params;
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await updateCampaign(keyActor(auth), id ?? "", json);
    if (!res.ok) return serviceFailure(res);
    return ok(publicCampaign(res.data));
  },
  { permission: "full" },
);

/**
 * Delete. Refused with a `409` while the campaign is `sending` — cancel it
 * first.
 *
 * Deleting is "stop listing this campaign", not "erase the send": the
 * `emails` rows it produced keep their bodies, their events and their
 * `campaignId`, because `emails.campaign_id` carries no constraint. What goes
 * is the campaign's own name, blocks and count cache.
 */
export const DELETE = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const res = await deleteCampaign(keyActor(auth), id ?? "");
    if (!res.ok) return serviceFailure(res);
    return noContent();
  },
  { permission: "full" },
);
