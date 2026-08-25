import { keyActor } from "@/lib/api-auth";
import {
  fail,
  ok,
  parsePage,
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
  async (req, auth) => {
    const q = parsePage(req);
    if (!q.ok) return q.res;
    const page = await listWebhooksPage(auth.team.id, q.data);
    return ok({
      data: page.data.map(publicWebhook),
      nextCursor: page.nextCursor,
    });
  },
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
