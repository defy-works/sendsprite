import { keyActor } from "@/lib/api-auth";
import { ok, serviceFailure, withApiKey } from "@/lib/api-response";
import { enqueue } from "@/jobs/enqueue";
import { sendTestEvent } from "@/services/webhooks";

export const dynamic = "force-dynamic";

/** 202 `{ deliveryId }`: the delivery runs on the worker. */
export const POST = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const res = await sendTestEvent(keyActor(auth), id ?? "", { enqueue });
    if (!res.ok) return serviceFailure(res);
    return ok(res.data, { status: 202 });
  },
  { permission: "full" },
);
