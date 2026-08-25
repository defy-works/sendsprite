import { AddSuppressionInput } from "@sendsprite/shared";
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

/** 201 with the row (also for an address that was already listed). */
export const POST = withApiKey(
  async (req, auth) => {
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const p = AddSuppressionInput.safeParse(json);
    if (!p.success)
      return fail(
        "validation_error",
        p.error.issues[0]?.message ?? "Invalid input.",
      );
    const res = await addSuppression(keyActor(auth), p.data);
    if (!res.ok) return fail("validation_error", res.error);
    return ok(view(res.data), { status: 201 });
  },
  { permission: "full" },
);
