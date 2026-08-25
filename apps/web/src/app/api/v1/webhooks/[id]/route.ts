import type { ErrorCode } from "@sendsprite/shared";
import { keyActor } from "@/lib/api-auth";
import { fail, noContent, ok, readJson, withApiKey } from "@/lib/api-response";
import {
  deleteWebhook,
  publicWebhook,
  updateWebhook,
} from "@/services/webhooks";

export const dynamic = "force-dynamic";

const codeOf = (code: string | undefined): ErrorCode =>
  code === "forbidden" || code === "not_found" ? code : "validation_error";

export const PATCH = withApiKey(
  async (req, auth, ctx) => {
    const { id } = await ctx.params;
    const body = await readJson(req);
    if (body === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await updateWebhook(keyActor(auth), id ?? "", body);
    if (!res.ok) return fail(codeOf(res.code), res.error);
    return ok(publicWebhook(res.data));
  },
  { permission: "full" },
);

export const DELETE = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const res = await deleteWebhook(keyActor(auth), id ?? "");
    if (!res.ok) return fail(codeOf(res.code), res.error);
    return noContent();
  },
  { permission: "full" },
);
