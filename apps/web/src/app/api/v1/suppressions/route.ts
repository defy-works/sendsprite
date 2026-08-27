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
  addSuppression,
  listSuppressionsPage,
  publicSuppression,
} from "@/services/suppressions";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  (req, auth) =>
    pagedList(
      req,
      (q) => listSuppressionsPage(auth.team.id, q),
      publicSuppression,
    ),
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
