import {
  fail,
  ok,
  rateHeaders,
  readJson,
  withApiKey,
} from "@/lib/api-response";
import { enqueue } from "@/jobs/enqueue";
import { listEvents } from "@/services/email-events";
import { getEmail, rescheduleEmail } from "@/services/emails";
import { publicEmail } from "@/services/ingest";
import { sendFailure } from "../_shared";

export const dynamic = "force-dynamic";

/** The email plus its timeline (`events`, oldest first). */
export const GET = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const headers = await rateHeaders(auth.team.id);
    const e = await getEmail(auth.team.id, id ?? "");
    if (!e) return fail("not_found", "Email not found.", undefined, headers);
    const events = (await listEvents(e.id)).map((ev) => ({
      id: ev.id,
      type: ev.type,
      occurredAt: ev.occurredAt.toISOString(),
      payload: ev.payload,
    }));
    return ok({ ...publicEmail(e), events }, { headers });
  },
  { permission: "full" },
);

/** `{ scheduledAt }` moves a `scheduled` email (409 for any other status). */
export const PATCH = withApiKey(
  async (req, auth, ctx) => {
    const { id } = await ctx.params;
    const body = (await readJson(req)) as { scheduledAt?: unknown } | undefined;
    const headers = await rateHeaders(auth.team.id);
    if (typeof body?.scheduledAt !== "string")
      return fail(
        "validation_error",
        "scheduledAt (ISO 8601 date-time) is required.",
        undefined,
        headers,
      );
    const res = await rescheduleEmail(
      auth.team.id,
      id ?? "",
      body.scheduledAt,
      {
        enqueue,
      },
    );
    if (!res.ok) return sendFailure(res, headers);
    return ok(publicEmail(res.data), { headers });
  },
  { permission: "full" },
);
