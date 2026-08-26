import { keyActor } from "@/lib/api-auth";
import { ok, serviceFailure, withApiKey } from "@/lib/api-response";
import { cancelCampaign, publicCampaign } from "@/services/campaigns/crud";

export const dynamic = "force-dynamic";

/**
 * Cancel: `scheduled` → `draft`, `sending` → `cancelled`. `409` otherwise.
 *
 * The two transitions are not the same act. Un-arming a `scheduled` campaign
 * has sent nothing, so it simply becomes an editable draft again and its time
 * is cleared. Cancelling a `sending` campaign is terminal, and it **stops
 * further fan-out only** — recipients already materialised are ordinary
 * `emails` rows on the ordinary send path, and anything already handed to SES
 * cannot be recalled by this route or by any other. The returned `counts`
 * therefore stay as they are and will keep rising for a while as delivery and
 * open events land for mail that was already in flight; a client showing them
 * should say so rather than present them as a final tally.
 */
export const POST = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const res = await cancelCampaign(keyActor(auth), id ?? "");
    if (!res.ok) return serviceFailure(res);
    return ok(publicCampaign(res.data));
  },
  { permission: "full" },
);
