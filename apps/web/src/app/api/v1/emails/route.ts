import { ListQuery } from "@sendsprite/shared";
import {
  fail,
  ok,
  rateHeaders,
  readJson,
  tooLarge,
  withApiKey,
} from "@/lib/api-response";
import { enqueue } from "@/jobs/enqueue";
import { createEmail, listEmails } from "@/services/emails";
import { publicEmail } from "@/services/ingest";
import { sendContext, sendFailure } from "./_shared";

export const dynamic = "force-dynamic";

/**
 * 201 `{ id }` (Resend-compatible); 200 with the earlier id when an
 * `idempotencyKey` replays. Sending-only keys may call this.
 */
export const POST = withApiKey(async (req, auth) => {
  const large = tooLarge(req);
  if (large) return large;
  const body = await readJson(req);
  if (body === undefined) return fail("validation_error", "Body must be JSON.");
  const res = await createEmail(sendContext(auth), body, { enqueue });
  const headers = await rateHeaders(auth.team.id);
  if (!res.ok) return sendFailure(res, headers);
  return ok({ id: res.data.id }, { status: res.created ? 201 : 200, headers });
});

/** `{ data, nextCursor }`; filters per `ListQuery` (limit, cursor, status, to, domainId, tag). */
export const GET = withApiKey(
  async (req, auth) => {
    const q = ListQuery.safeParse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    if (!q.success)
      return fail(
        "validation_error",
        q.error.issues[0]?.message ?? "Invalid query.",
        q.error.issues,
      );
    const page = await listEmails(auth.team.id, q.data);
    return ok(
      { data: page.data.map(publicEmail), nextCursor: page.nextCursor },
      { headers: await rateHeaders(auth.team.id) },
    );
  },
  { permission: "full" },
);
