import { keyActor } from "@/lib/api-auth";
import { noContent, serviceFailure, withApiKey } from "@/lib/api-response";
import { revokeApiKey } from "@/services/api-keys";

export const dynamic = "force-dynamic";

export const DELETE = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const res = await revokeApiKey(keyActor(auth), id ?? "");
    if (!res.ok) return serviceFailure(res);
    return noContent();
  },
  { permission: "full" },
);
