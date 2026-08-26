import { z } from "zod";
import { CAMPAIGN_STATUSES, PageQuery } from "@sendsprite/shared";
import { keyActor } from "@/lib/api-auth";
import {
  fail,
  ok,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import {
  createCampaign,
  listCampaignsPage,
  publicCampaign,
} from "@/services/campaigns/crud";

export const dynamic = "force-dynamic";

/**
 * Campaigns are a management surface, so **every route under `/campaigns`
 * requires a `full` key** — reads included.
 *
 * This is a stronger rule than "writes need a full key", and the reason is
 * blast radius rather than tidiness. A `sending_only` key exists to be
 * deployed somewhere a `full` key should not go: an application server that
 * sends password resets and receipts. If such a key could reach this surface
 * it could schedule a campaign against a customer's entire contact book, one
 * `POST` away from mailing every contact the team has. That is categorically
 * larger than the transactional scope the permission implies, so the answer
 * is `403` on all eight operations, not on the mutating ones.
 *
 * `GET /campaigns/{id}/audience` is under the same rule for a quieter reason:
 * it reports how many contacts a team holds, which a sending-only key has no
 * business counting.
 */
const ListCampaignsQuery = PageQuery.extend({
  status: z.enum(CAMPAIGN_STATUSES).optional(),
});

/**
 * `{ data, nextCursor }`, newest first, optionally filtered by `status`.
 *
 * The status filter is a plain enum rather than a coerced string: `?status=drft`
 * is a `validation_error` naming the field, not a silently empty page that
 * reads as "you have no drafts".
 */
export const GET = withApiKey(
  async (req, auth) => {
    const q = ListCampaignsQuery.safeParse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    if (!q.success)
      return fail(
        "validation_error",
        q.error.issues[0]?.message ?? "Invalid query.",
        q.error.issues,
      );
    const page = await listCampaignsPage(auth.team.id, q.data);
    if (!page.ok) return serviceFailure(page);
    return ok({
      data: page.data.data.map(publicCampaign),
      nextCursor: page.data.nextCursor,
    });
  },
  { permission: "full" },
);

/**
 * 201 with the campaign as a `draft`. Nothing here sends or schedules — that
 * is `POST /campaigns/{id}/schedule`.
 *
 * A `bookId` or `domainId` that is unknown, belongs to another team, or names
 * an unverified domain is a `400`/`422` naming the field: the columns carry no
 * foreign key, so this check is the only thing standing between a typo and a
 * campaign addressed at another team's contacts.
 */
export const POST = withApiKey(
  async (req, auth) => {
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await createCampaign(keyActor(auth), json);
    if (!res.ok) return serviceFailure(res);
    return ok(publicCampaign(res.data), { status: 201 });
  },
  { permission: "full" },
);
