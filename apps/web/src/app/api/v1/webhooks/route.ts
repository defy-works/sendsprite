import { keyActor } from "@/lib/api-auth";
import {
  fail,
  ok,
  pagedList,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import {
  createWebhook,
  listWebhooksPage,
  publicWebhook,
} from "@/services/webhooks";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  (req, auth) =>
    pagedList(req, (q) => listWebhooksPage(auth.team.id, q), publicWebhook),
  { permission: "full" },
);

/** 201 `{ id, secret }` — the only time the secret is ever returned. */
export const POST = withApiKey(
  async (req, auth) => {
    const body = await readJson(req);
    if (body === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await createWebhook(keyActor(auth), body);
    if (!res.ok) return serviceFailure(res);
    return ok(res.data, { status: 201 });
  },
  { permission: "full" },
);
