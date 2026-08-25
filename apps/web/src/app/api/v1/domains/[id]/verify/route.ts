import { keyActor } from "@/lib/api-auth";
import { fail, ok, withApiKey } from "@/lib/api-response";
import { enqueue } from "@/jobs/enqueue";
import { getDomain, publicDomain, reverifyDomain } from "@/services/domains";
import { domainFailure } from "../../_shared";

export const dynamic = "force-dynamic";

/** Runs one verification check now and returns the updated domain. */
export const POST = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const res = await reverifyDomain(keyActor(auth), id ?? "", { enqueue });
    if (!res.ok) return domainFailure(res);
    const d = await getDomain(auth.team.id, id ?? "");
    if (!d) return fail("not_found", "Domain not found.");
    return ok(publicDomain(d));
  },
  { permission: "full" },
);
