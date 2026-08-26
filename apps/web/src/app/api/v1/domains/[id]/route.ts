import { keyActor } from "@/lib/api-auth";
import {
  fail,
  noContent,
  ok,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import { deleteDomain, getDomain, publicDomain } from "@/services/domains";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const d = await getDomain(auth.team.id, id ?? "");
    if (!d) return fail("not_found", "Domain not found.");
    return ok(publicDomain(d));
  },
  { permission: "full" },
);

/**
 * Removes the SES identity and our DNS records, then the domain: 204, or
 * 200 `{ leftoverDnsRecords }` when some Cloudflare records could not be
 * removed and need cleaning up by hand.
 */
export const DELETE = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const res = await deleteDomain(keyActor(auth), id ?? "", {});
    if (!res.ok) return serviceFailure(res);
    return res.data.leftoverDnsRecords > 0 ? ok(res.data) : noContent();
  },
  { permission: "full" },
);
