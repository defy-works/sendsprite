import { keyActor } from "@/lib/api-auth";
import { fail, noContent, withApiKey } from "@/lib/api-response";
import { removeSuppression } from "@/services/suppressions";

export const dynamic = "force-dynamic";

/** The segment arrives percent-encoded (`a%40b.io`, `a%2Btag%40b.io`). */
export const DELETE = withApiKey(
  async (_req, auth, ctx) => {
    const { email } = await ctx.params;
    let decoded: string;
    try {
      decoded = decodeURIComponent(email ?? "");
    } catch {
      return fail("validation_error", "Malformed email in URL.");
    }
    const res = await removeSuppression(keyActor(auth), decoded);
    if (!res.ok)
      return fail(
        res.code === "forbidden" ? "forbidden" : "not_found",
        res.error,
      );
    return noContent();
  },
  { permission: "full" },
);
