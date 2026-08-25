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
  addSuppression,
  listSuppressionsPage,
  publicSuppression,
} from "@/services/suppressions";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  async (req, auth) => {
    const q = parsePage(req);
    if (!q.ok) return q.res;
    const page = await listSuppressionsPage(auth.team.id, q.data);
    return ok({
      data: page.data.map(publicSuppression),
      nextCursor: page.nextCursor,
    });
  },
  { permission: "full" },
);

/** 201 with the row (also for an address that was already listed). */
export const POST = withApiKey(
  async (req, auth) => {
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await addSuppression(keyActor(auth), json);
    if (!res.ok) return serviceFailure(res);
    return ok(publicSuppression(res.data), { status: 201 });
  },
  { permission: "full" },
);
