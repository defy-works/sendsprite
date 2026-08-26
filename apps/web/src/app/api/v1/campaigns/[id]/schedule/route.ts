import { keyActor } from "@/lib/api-auth";
import { fail, ok, serviceFailure, withApiKey } from "@/lib/api-response";
import { publicCampaign, scheduleCampaign } from "@/services/campaigns/crud";

export const dynamic = "force-dynamic";

/**
 * Arm a campaign: `{ "scheduledAt": "…" }`, or **no body at all** to start now.
 *
 * The body is read as text rather than through `readJson`, because those two
 * cases have to be told apart. `readJson` answers `undefined` both for "there
 * was no body" and for "the body was not JSON", and here the first is a valid
 * request meaning *now* while the second is a `400`. An empty body becomes
 * `{}` and a malformed one is refused, so a client whose serialiser emitted
 * rubbish is told, instead of silently mailing a contact book immediately.
 *
 * The campaign becomes `scheduled`, never `sending` — including for "now".
 * `campaign.start-sweep` is the only thing that starts a send (it renders the
 * body once and stamps `started_at`), so this route sets the time and the
 * sweep does the rest on its next tick.
 *
 * `409` unless the campaign is `draft` or `scheduled`; `400` for a time in the
 * past; `400`/`422` if the contact book or the domain has gone missing or the
 * domain is no longer verified since the campaign was authored — this is the
 * last moment before mail leaves, so all of it is re-checked.
 */
export const POST = withApiKey(
  async (req, auth, ctx) => {
    const { id } = await ctx.params;
    const raw = await req.text();
    let body: unknown = {};
    if (raw.trim())
      try {
        body = JSON.parse(raw);
      } catch {
        return fail("validation_error", "Body must be JSON.");
      }
    const res = await scheduleCampaign(keyActor(auth), id ?? "", body);
    if (!res.ok) return serviceFailure(res);
    return ok(publicCampaign(res.data));
  },
  { permission: "full" },
);
