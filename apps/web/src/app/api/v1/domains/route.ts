import { keyActor } from "@/lib/api-auth";
import { fail, ok, readJson, withApiKey } from "@/lib/api-response";
import { enqueue } from "@/jobs/enqueue";
import { createDomain, listDomains, publicDomain } from "@/services/domains";
import { domainFailure } from "./_shared";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  async (_req, auth) =>
    ok({ data: (await listDomains(auth.team.id)).map(publicDomain) }),
  { permission: "full" },
);

/** 201 with the domain; provisioning runs in the background (poll `GET /:id`). */
export const POST = withApiKey(
  async (req, auth) => {
    const body = await readJson(req);
    if (body === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await createDomain(keyActor(auth), body, { enqueue });
    if (!res.ok) return domainFailure(res);
    return ok(publicDomain(res.data), { status: 201 });
  },
  { permission: "full" },
);
