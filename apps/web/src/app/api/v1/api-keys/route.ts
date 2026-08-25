import { keyActor } from "@/lib/api-auth";
import { fail, ok, readJson, withApiKey } from "@/lib/api-response";
import { createApiKey, listApiKeys } from "@/services/api-keys";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  async (_req, auth) => {
    const rows = await listApiKeys(auth.team.id);
    return ok({
      data: rows
        .filter((k) => !k.revokedAt)
        .map((k) => ({
          id: k.id,
          name: k.name,
          permission: k.permission,
          keyPrefix: k.keyPrefix,
          domainId: k.domainId,
          lastUsedAt: k.lastUsedAt,
          createdAt: k.createdAt,
        })),
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
    const res = await createApiKey(keyActor(auth), body);
    if (!res.ok) return fail("validation_error", res.error);
    return ok(res.data, { status: 201 });
  },
  { permission: "full" },
);
