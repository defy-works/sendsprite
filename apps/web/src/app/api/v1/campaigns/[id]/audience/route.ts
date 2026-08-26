import { fail, ok, withApiKey } from "@/lib/api-response";
import { audiencePreview } from "@/services/campaigns/audience";
import { getCampaign } from "@/services/campaigns/crud";

export const dynamic = "force-dynamic";

/**
 * Who this campaign would reach, counted live against its contact book.
 *
 * The four numbers are four views of one population, not four buckets that
 * sum to it: `eligible` is `subscribed` **and** not `suppressed`, and it is
 * the only one that will actually be mailed. They are counted at read time
 * rather than stored, so this is a preview and not a promise — the audience
 * is not frozen until the fan-out walks it.
 *
 * A campaign whose book has since been deleted answers four zeros rather than
 * a `404`: the campaign exists, and "nobody is eligible" is the truthful
 * answer to the question asked. The `404` here means the *campaign* is not
 * this team's.
 */
export const GET = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const c = await getCampaign(auth.team.id, id ?? "");
    if (!c) return fail("not_found", "Campaign not found.");
    return ok(await audiencePreview(auth.team.id, c.bookId));
  },
  { permission: "full" },
);
