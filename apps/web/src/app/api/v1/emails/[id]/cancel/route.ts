import {
  ok,
  rateHeaders,
  withApiKey,
  serviceFailure,
} from "@/lib/api-response";
import { cancelEmail } from "@/services/emails";
import { publicEmail } from "@/services/ingest";

export const dynamic = "force-dynamic";

/** Cancels a `queued`/`scheduled` email (409 otherwise); returns it. */
export const POST = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const headers = await rateHeaders(auth.team.id);
    const res = await cancelEmail(auth.team.id, id ?? "", `api:${auth.key.id}`);
    if (!res.ok) return serviceFailure(res, headers);
    return ok(publicEmail(res.data), { headers });
  },
  { permission: "full" },
);
