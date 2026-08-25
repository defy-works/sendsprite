import { z } from "zod";
import { keyActor } from "@/lib/api-auth";
import { fail, ok, readJson, withApiKey } from "@/lib/api-response";
import {
  addSuppression,
  listSuppressions,
  type Suppression,
} from "@/services/suppressions";

export const dynamic = "force-dynamic";

const view = (s: Suppression) => ({
  id: s.id,
  email: s.email,
  reason: s.reason,
  note: s.note,
  sourceEmailId: s.sourceEmailId,
  createdAt: s.createdAt,
});

export const GET = withApiKey(
  async (_req, auth) =>
    ok({ data: (await listSuppressions(auth.team.id)).map(view) }),
  { permission: "full" },
);

/** Bounce/complaint entries come only from SES events; the API adds manual/unsubscribe. */
const body = z.object({
  email: z.unknown(),
  reason: z.enum(["manual", "unsubscribe"]).default("manual"),
  note: z.unknown().optional(),
});

/** 201 with the row (also for an address that was already listed). */
export const POST = withApiKey(
  async (req, auth) => {
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const p = body.safeParse(json);
    if (!p.success)
      return fail(
        "validation_error",
        'reason must be "manual" or "unsubscribe".',
      );
    const res = await addSuppression(keyActor(auth), p.data);
    if (!res.ok) return fail("validation_error", res.error);
    return ok(view(res.data), { status: 201 });
  },
  { permission: "full" },
);
