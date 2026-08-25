import { keyActor } from "@/lib/api-auth";
import {
  fail,
  ok,
  pagedList,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import { enqueue } from "@/jobs/enqueue";
import {
  createDomain,
  listDomainsPage,
  publicDomain,
} from "@/services/domains";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  (req, auth) =>
    pagedList(req, (q) => listDomainsPage(auth.team.id, q), publicDomain),
  { permission: "full" },
);

/** 201 with the domain; provisioning runs in the background (poll `GET /:id`). */
export const POST = withApiKey(
  async (req, auth) => {
    const body = await readJson(req);
    if (body === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await createDomain(keyActor(auth), body, { enqueue });
    if (!res.ok) return serviceFailure(res);
    return ok(publicDomain(res.data), { status: 201 });
  },
  { permission: "full" },
);
