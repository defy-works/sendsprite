import {
  fail,
  ok,
  rateHeaders,
  readJson,
  tooLarge,
  withApiKey,
  serviceFailure,
} from "@/lib/api-response";
import { enqueue } from "@/jobs/enqueue";
import { createBatch } from "@/services/emails";
import { sendContext } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * 201 `{ data: [{ id }] }`. Items are created in order; on the first
 * refusal the envelope carries `details.index` and the earlier items stay
 * queued. Sending-only keys may call this.
 */
export const POST = withApiKey(async (req, auth) => {
  const large = tooLarge(req);
  if (large) return large;
  const body = await readJson(req);
  if (body === undefined) return fail("validation_error", "Body must be JSON.");
  const res = await createBatch(sendContext(auth), body, { enqueue });
  const headers = await rateHeaders(auth.team.id);
  if (!res.ok) return serviceFailure(res, headers);
  return ok({ data: res.data }, { status: 201, headers });
});
