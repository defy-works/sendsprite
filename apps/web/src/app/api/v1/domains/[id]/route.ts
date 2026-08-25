import { keyActor } from "@/lib/api-auth";
import { fail, noContent, ok, withApiKey } from "@/lib/api-response";
import { deleteDomain, getDomain, publicDomain } from "@/services/domains";
import { domainFailure } from "../_shared";

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

/** Removes the SES identity and our DNS records, then the domain (204). */
export const DELETE = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const res = await deleteDomain(keyActor(auth), id ?? "", {});
    if (!res.ok) return domainFailure(res);
    return noContent();
  },
  { permission: "full" },
);
