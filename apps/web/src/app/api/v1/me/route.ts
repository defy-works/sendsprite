import type { MeObject } from "@sendsprite/shared";
import { ok, withApiKey } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/** What the bearer key can see about itself. Any permission. */
export const GET = withApiKey(async (_req, auth) =>
  ok({
    team: { id: auth.team.id, name: auth.team.name },
    apiKey: {
      id: auth.key.id,
      name: auth.key.name,
      permission: auth.key.permission,
      keyPrefix: auth.key.keyPrefix,
      domainId: auth.key.domainId,
    },
  } satisfies MeObject),
);
