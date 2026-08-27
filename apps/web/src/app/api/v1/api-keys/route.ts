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
  createApiKey,
  listApiKeysPage,
  publicApiKey,
} from "@/services/api-keys";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  (req, auth) =>
    pagedList(req, (q) => listApiKeysPage(auth.team.id, q), publicApiKey),
  { permission: "full" },
);

/** 201 `{ id, secret }` — the only time the secret is ever returned. */
export const POST = withApiKey(
  async (req, auth) => {
    const body = await readJson(req);
    if (body === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await createApiKey(keyActor(auth), body);
    if (!res.ok) return serviceFailure(res);
    return ok(res.data, { status: 201 });
  },
  { permission: "full" },
);
