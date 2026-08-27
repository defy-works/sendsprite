import { and, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import {
  CreateCampaignInput,
  ScheduleCampaignInput,
  UpdateCampaignInput,
  can,
  newId,
  type CampaignStatus,
} from "@sendsprite/shared";
import { db } from "@/db";
import type { Page } from "@/db/keyset";
import { campaigns, contactBooks, domains, type Campaign } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { canonicalJson } from "@/lib/canonical-json";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import type { Result } from "@/lib/result";
import { resolveSendingDomain } from "../emails";
import type { TeamActor } from "../team";

export type { Campaign };

/**
 * Campaign CRUD (spec §5, Phase 7) — the one write path the dashboard and
 * `/api/v1/campaigns` both go through.
 *
 * Shaped after `services/templates.ts`: every expected refusal is a `Result`
 * rather than a throw, the permission check runs **before** any lookup so a
 * forbidden actor cannot probe which ids exist, and every mutation writes a
 * `recordAudit` row under the `<resource>.<verb>` naming the rest of the
 * repo uses (`templates.create`, `contactBooks.delete`, …).
 *
 * Two things are specific to campaigns and load-bearing:
 *
 * 1. **`sending` and `sent` are immutable.** Editing the blocks of a
 *    half-sent campaign means the first 10 000 recipients got one mail and
 *    the rest got another, under one name and one set of stats — an
 *    incoherence a customer cannot untangle afterwards. `cancelled` is
 *    immutable for the same reason: it is only reachable from `sending`, so
 *    some of its mail has already left. Only `draft` and `scheduled` are
 *    editable, and editing a `scheduled` campaign reverts it to `draft` so
 *    nobody ships an unreviewed change on a timer. The status is re-asserted
 *    in the `where` clause of the write, not just read beforehand: the
 *    fan-out sweep can flip `scheduled` → `sending` between the two.
 * 2. **`book_id` and `domain_id` carry no foreign key** (see
 *    `db/schema/campaigns.ts` for why), so nothing but this module stops a
 *    campaign naming another team's contact book — which would mail another
 *    team's contacts. Both refs are therefore checked on create *and* on
 *    update, against the merged next state rather than only the fields the
 *    caller happened to send. Symmetrically, a campaign outlives a deleted
 *    book or domain, so every read left-joins and reports the missing side
 *    instead of dropping the row.
 */

const DENIED: Result<never> = {
  ok: false,
  code: "forbidden",
  error: "You don't have permission to do that.",
};
const NOT_FOUND: Result<never> = {
  ok: false,
  code: "not_found",
  error: "Campaign not found.",
};

/** Default page size, and the ceiling `PageQuery` already enforces at the edge. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * The statuses an edit may touch.
 *
 * `sending`, `sent` and `cancelled` are all "mail has already left under this
 * name"; see the module comment.
 */
export const EDITABLE_STATUSES = ["draft", "scheduled"] as const;

/**
 * The plan names this type; it is `TeamActor` with nothing added.
 *
 * An alias rather than a second interface on purpose — a parallel actor type
 * would drift from the one `recordAudit` and every other service already
 * take, and there is nothing a campaign mutation needs that they do not
 * carry.
 */
export type CampaignActor = TeamActor;

type DomainStatus = (typeof domains.$inferSelect)["status"];

/**
 * What the row points at, as far as it still exists.
 *
 * `null` is not an error: `campaigns.book_id`/`domain_id` have no foreign
 * key, so a campaign genuinely outlives its book and its domain, and "the
 * book is gone" is the truth a list has to render rather than a reason to
 * drop the row or throw.
 */
export interface CampaignRefs {
  book: { id: string; name: string } | null;
  domain: { id: string; name: string; status: DomainStatus } | null;
}

/** A campaign row plus whatever survives of what it references. */
export type CampaignWithRefs = Campaign & CampaignRefs;

export interface ListCampaignsQuery {
  limit?: number;
  cursor?: string;
  status?: CampaignStatus;
}

/**
 * REST shape: no `team_id`, no `html`/`text` (rendered artefacts, not fields
 * anyone sets), no `fanout_cursor` (bookkeeping).
 *
 * Dates go out as `Date`, exactly as `publicTemplate` returns them: the
 * envelope is JSON-serialised at the edge, where a `Date` becomes the ISO
 * string `CampaignObject` declares.
 */
export const publicCampaign = (c: Campaign) => ({
  id: c.id,
  name: c.name,
  bookId: c.bookId,
  domainId: c.domainId,
  from: c.from,
  replyTo: c.replyTo,
  subject: c.subject,
  blocks: c.blocks,
  theme: c.theme,
  mergeDefaults: c.mergeDefaults,
  status: c.status,
  scheduledAt: c.scheduledAt,
  sentAt: c.sentAt,
  counts: c.counts,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

/**
 * The left joins every read goes through.
 *
 * Both are joined on `(id, team_id)` rather than on the id alone. Without the
 * team predicate a campaign carrying a cross-team `book_id` — one written
 * before this module existed, or by a future path that forgets to check —
 * would render another team's book *name* in this team's dashboard. The join
 * that cannot leak is cheaper than the audit that finds out it did.
 */
const withRefs = () =>
  db()
    .select({
      campaign: campaigns,
      bookName: contactBooks.name,
      domainName: domains.name,
      domainStatus: domains.status,
    })
    .from(campaigns)
    .leftJoin(
      contactBooks,
      and(
        eq(contactBooks.id, campaigns.bookId),
        eq(contactBooks.teamId, campaigns.teamId),
      ),
    )
    .leftJoin(
      domains,
      and(
        eq(domains.id, campaigns.domainId),
        eq(domains.teamId, campaigns.teamId),
      ),
    );

type RefRow = {
  campaign: Campaign;
  bookName: string | null;
  domainName: string | null;
  domainStatus: DomainStatus | null;
};

const toRefs = (r: RefRow): CampaignWithRefs => ({
  ...r.campaign,
  book:
    r.bookName === null ? null : { id: r.campaign.bookId, name: r.bookName },
  domain:
    r.domainName === null || r.domainStatus === null
      ? null
      : {
          id: r.campaign.domainId,
          name: r.domainName,
          status: r.domainStatus,
        },
});

/**
 * One page, newest first, keyset-paged on `(created_at, id)`.
 *
 * Hand-rolled rather than `keysetPage`, which selects a whole table and so
 * cannot carry the joins. The ordering, the `limit + 1` probe and the cursor
 * encoding are deliberately identical to it, because the two pagers are
 * walked by the same client with the same cursors.
 */
export async function listCampaignsPage(
  teamId: string,
  q: ListCampaignsQuery = {},
): Promise<Result<Page<CampaignWithRefs>>> {
  const cur = q.cursor ? decodeCursor(q.cursor) : null;
  if (q.cursor && !cur) return { ok: false, error: "Invalid cursor." };
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const where: (SQL | undefined)[] = [eq(campaigns.teamId, teamId)];
  if (q.status) where.push(eq(campaigns.status, q.status));
  if (cur)
    where.push(
      sql`(${campaigns.createdAt}, ${campaigns.id}) < (${cur.createdAt.toISOString()}::timestamptz, ${cur.id})`,
    );
  const rows = await withRefs()
    .where(and(...where))
    .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
    .limit(limit + 1);
  const data = rows.slice(0, limit).map(toRefs);
  const last = data.at(-1);
  return {
    ok: true,
    data: {
      data,
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    },
  };
}

/**
 * The bare row, scoped to the team.
 *
 * This is what the fan-out, the schedule sweep and the audience service read:
 * they want the campaign, not its dashboard decoration, and passing a row
 * carrying extra keys into a drizzle `update()` is a trap. Callers that
 * render a campaign want `getCampaignDetail`.
 */
export async function getCampaign(
  teamId: string,
  id: string,
): Promise<Campaign | null> {
  const key = id.trim();
  if (!key) return null;
  const [row] = await db()
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.teamId, teamId), eq(campaigns.id, key)))
    .limit(1);
  return row ?? null;
}

/** The same row with its book and domain left-joined; either may be gone. */
export async function getCampaignDetail(
  teamId: string,
  id: string,
): Promise<CampaignWithRefs | null> {
  const key = id.trim();
  if (!key) return null;
  const [row] = await withRefs()
    .where(and(eq(campaigns.teamId, teamId), eq(campaigns.id, key)))
    .limit(1);
  return row ? toRefs(row) : null;
}

/**
 * Both references, checked against the team, plus the domain's verification.
 *
 * The database cannot do any of this — there is no foreign key — so a
 * `bookId` that reaches the insert unchecked is a data leak, not a dangling
 * pointer: the campaign would mail another team's contacts. A cross-team id
 * gets the same "not found" as an unknown one; which of the two it was is not
 * this team's business.
 *
 * Verification is `resolveSendingDomain`'s notion and no other: the same
 * longest-suffix match against the team's `verified` domains that
 * `createEmail` runs, so a campaign cannot be created against a domain the
 * send path would then refuse. It is checked again when sending starts —
 * a domain can be deleted or fail re-verification in between, the same
 * two-times-for-two-moments reasoning as the suppression check.
 */
async function checkRefs(
  teamId: string,
  bookId: string,
  domainId: string,
  from: string,
): Promise<Result<undefined>> {
  const [book] = await db()
    .select({ id: contactBooks.id })
    .from(contactBooks)
    .where(and(eq(contactBooks.id, bookId), eq(contactBooks.teamId, teamId)))
    .limit(1);
  if (!book)
    return {
      ok: false,
      code: "validation_error",
      error: "Contact book not found.",
      details: { field: "bookId" },
    };
  const [domain] = await db()
    .select({ id: domains.id, name: domains.name, status: domains.status })
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.teamId, teamId)))
    .limit(1);
  if (!domain)
    return {
      ok: false,
      code: "validation_error",
      error: "Domain not found.",
      details: { field: "domainId" },
    };
  if (domain.status !== "verified")
    return {
      ok: false,
      code: "domain_not_verified",
      error: `${domain.name} is not verified — a campaign sent from it would fail for every recipient.`,
      details: { field: "domainId" },
    };
  const resolved = await resolveSendingDomain(teamId, from);
  if (!resolved || resolved.id !== domain.id)
    return {
      ok: false,
      code: "domain_not_verified",
      error: `${from} is not an address at ${domain.name}.`,
      details: { field: "from" },
    };
  return { ok: true, data: undefined };
}

export async function createCampaign(
  actor: CampaignActor,
  raw: unknown,
): Promise<Result<Campaign>> {
  if (!can(actor.role, "campaigns.manage")) return DENIED;
  const p = CreateCampaignInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const refs = await checkRefs(
    actor.teamId,
    p.data.bookId,
    p.data.domainId,
    p.data.from,
  );
  if (!refs.ok) return refs;
  const [row] = await db()
    .insert(campaigns)
    .values({
      id: newId("cmp"),
      teamId: actor.teamId,
      bookId: p.data.bookId,
      domainId: p.data.domainId,
      name: p.data.name,
      subject: p.data.subject,
      from: p.data.from,
      replyTo: p.data.replyTo ?? null,
      blocks: p.data.blocks,
      theme: p.data.theme ?? null,
      mergeDefaults: p.data.mergeDefaults ?? null,
      // `status`, `counts` and the timestamps take their column defaults: a
      // campaign is always born a `draft` with an all-zero count cache.
      createdBy: actor.userId,
    })
    .returning();
  if (!row) throw new Error("campaigns insert returned no row");
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "campaigns.create",
    targetType: "campaign",
    targetId: row.id,
    diff: {
      name: { to: row.name },
      bookId: { to: row.bookId },
      domainId: { to: row.domainId },
    },
  });
  return { ok: true, data: row };
}

/** Everything an update may move. `html`/`text` are rendered, never set. */
const EDITABLE_FIELDS = [
  "name",
  "bookId",
  "domainId",
  "from",
  "replyTo",
  "subject",
  "blocks",
  // Compared structurally like `blocks`, and for the same jsonb reason: an
  // unchanged theme re-sent on every save must not read as an edit, because
  // an edit reverts a scheduled campaign to a draft.
  "theme",
  "mergeDefaults",
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];
type EditableValues = Pick<Campaign, EditableField>;

/**
 * `JSON.stringify` with every object's keys sorted, at every depth.
 *
 * Sorted rather than as-written because `blocks` is a **jsonb** column, and
 * jsonb does not preserve key order — it stores keys sorted by length then
 * bytewise, so the `{ kind, html }` a `TextBlock` parses to comes back out of
 * Postgres as `{ html, kind }`. A plain `JSON.stringify` comparison between
 * the parsed input and the stored row therefore reports a change on every
 * single save, and here that is not merely a spurious audit row: an "edit"
 * reverts a scheduled campaign to a draft, so re-saving an unchanged body
 * would silently cancel its schedule.
 */
/**
 * The fields whose **value** differs.
 *
 * Structural rather than `Object.is`, for `blocks`: the editor re-sends the
 * whole block list on every save, so reference equality would call each save
 * an edit — and an edit here is not free, it reverts a scheduled campaign to
 * a draft.
 */
const changedFields = (
  before: EditableValues,
  after: EditableValues,
): EditableField[] =>
  EDITABLE_FIELDS.filter(
    (f) => canonicalJson(before[f]) !== canonicalJson(after[f]),
  );

/**
 * Edit a `draft` or `scheduled` campaign; anything further along is immutable.
 *
 * A `scheduled` campaign reverts to `draft`, and its `scheduledAt` is cleared
 * with it: leaving a time on a draft would make the sweep (which selects on
 * `status`) and the dashboard (which shows the time) describe two different
 * futures. Re-scheduling is an explicit act, which is the point — an edit
 * must not ship on the old timer.
 */
export async function updateCampaign(
  actor: CampaignActor,
  id: string,
  raw: unknown,
): Promise<Result<Campaign>> {
  if (!can(actor.role, "campaigns.manage")) return DENIED;
  const p = UpdateCampaignInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const current = await getCampaign(actor.teamId, id);
  if (!current) return NOT_FOUND;
  if (!(EDITABLE_STATUSES as readonly string[]).includes(current.status))
    return {
      ok: false,
      code: "conflict",
      error: `A campaign that is ${current.status} cannot be edited.`,
    };
  const next: EditableValues = {
    name: p.data.name ?? current.name,
    bookId: p.data.bookId ?? current.bookId,
    domainId: p.data.domainId ?? current.domainId,
    from: p.data.from ?? current.from,
    replyTo: p.data.replyTo === undefined ? current.replyTo : p.data.replyTo,
    subject: p.data.subject ?? current.subject,
    blocks: p.data.blocks ?? current.blocks,
    // `null` is a real value here — "reset to the defaults" — so only
    // `undefined` means "leave it alone".
    theme: p.data.theme === undefined ? current.theme : p.data.theme,
    mergeDefaults:
      p.data.mergeDefaults === undefined
        ? current.mergeDefaults
        : p.data.mergeDefaults,
  };
  const fields = changedFields(current, next);
  // Nothing moved: no write, no audit row, and — the reason this check is
  // load-bearing here rather than merely tidy — no revert of a schedule.
  if (!fields.length) return { ok: true, data: current };
  // The merged state, not just the fields the caller sent: a campaign whose
  // book was deleted since it was created must not be editable into a state
  // that still points at nothing.
  const refs = await checkRefs(
    actor.teamId,
    next.bookId,
    next.domainId,
    next.from,
  );
  if (!refs.ok) return refs;
  const wasScheduled = current.status === "scheduled";
  const [row] = await db()
    .update(campaigns)
    .set({
      ...next,
      ...(wasScheduled && { status: "draft" as const, scheduledAt: null }),
    })
    .where(
      and(
        eq(campaigns.id, current.id),
        eq(campaigns.teamId, actor.teamId),
        // Re-asserted here, not merely read above: the fan-out sweep can move
        // a `scheduled` campaign to `sending` between the read and this
        // write, and an edit that lands then is exactly the half-sent
        // incoherence the status check exists to prevent.
        inArray(campaigns.status, [...EDITABLE_STATUSES]),
      ),
    )
    .returning();
  if (!row)
    return {
      ok: false,
      code: "conflict",
      error: "This campaign started sending while you were editing it.",
    };
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "campaigns.update",
    targetType: "campaign",
    targetId: row.id,
    // Which fields moved, not what they moved to: a block list is the size of
    // an email, and the campaign row is the content.
    diff: {
      fields: { to: fields.join(", ") },
      ...(wasScheduled && { status: { from: "scheduled", to: row.status } }),
    },
  });
  return { ok: true, data: row };
}

/**
 * Delete a campaign. Refused while it is `sending`.
 *
 * ## What happens to a sent campaign's history
 *
 * `campaign_recipients` cascades away — those rows are the fan-out's working
 * state, not history. The `emails` rows do **not**: `emails.campaign_id` and
 * `contact_id` deliberately carry no constraint (see `db/schema/emails.ts`),
 * so every message that was actually sent stays in the mail log, keeps its
 * body-retention and billing story, and keeps the id of the campaign that
 * produced it. Deleting is therefore not "erase the send"; it is "stop
 * listing this campaign", and what is lost is the campaign's own name,
 * blocks and count cache — not the record that the mail went out. That is
 * the deliberate choice: a team that tidies up an old campaign has not asked
 * to forget having mailed anyone, and refusing to delete `sent` campaigns
 * outright would mean a team could never clear a list that only grows.
 *
 * `sending` is the one refusal. A delete mid-fan-out races the sweep, which
 * would go on materialising rows for a campaign that no longer exists;
 * cancelling first is the supported way to stop it.
 */
export async function deleteCampaign(
  actor: CampaignActor,
  id: string,
): Promise<Result> {
  if (!can(actor.role, "campaigns.manage")) return DENIED;
  const current = await getCampaign(actor.teamId, id);
  if (!current) return NOT_FOUND;
  if (current.status === "sending")
    return {
      ok: false,
      code: "conflict",
      error: "A campaign that is sending cannot be deleted. Cancel it first.",
    };
  const [row] = await db()
    .delete(campaigns)
    .where(
      and(
        eq(campaigns.id, current.id),
        eq(campaigns.teamId, actor.teamId),
        // As in `updateCampaign`: the sweep may have started it since the
        // read, and a half-deleted fan-out has no honest end state.
        ne(campaigns.status, "sending"),
      ),
    )
    .returning({
      id: campaigns.id,
      name: campaigns.name,
      status: campaigns.status,
    });
  if (!row)
    return {
      ok: false,
      code: "conflict",
      error: "This campaign started sending while you were deleting it.",
    };
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "campaigns.delete",
    targetType: "campaign",
    targetId: row.id,
    diff: { name: { from: row.name }, status: { from: row.status } },
  });
  return { ok: true, data: undefined };
}

/**
 * Arm a `draft` (or re-arm a `scheduled`) campaign.
 *
 * The end state is always `scheduled`, never `sending` — even for "send now",
 * which is `scheduledAt` omitted and therefore `scheduledAt = now`. The
 * `campaign.start-sweep` is the only thing that moves a campaign into
 * `sending`, because starting is not a status flip: it renders `html`/`text`
 * once and stamps `started_at`, and a request handler that did that itself
 * would be a second start path racing the sweep for the same campaign. So
 * "start now" means "due now", and the next sweep tick picks it up.
 *
 * That is also why the sweep's `scheduled_at <= now` comparison forces a
 * concrete timestamp here rather than a null one: a `scheduled` row with no
 * time is never due, so it would sit armed and silent forever.
 *
 * ## Everything is re-checked, because this is the last quiet moment
 *
 * A campaign may have been authored weeks ago. Between then and now its book
 * or its domain can have been deleted (neither is a foreign key — see the
 * module comment), and the domain can have failed re-verification. `checkRefs`
 * is therefore run again in full, exactly as `createCampaign` runs it: after
 * this call the next thing to touch the campaign is the sweep, which renders
 * and fans out. A refusal here is a form error; the same problem noticed a
 * minute later is a campaign that hard-bounces for every recipient.
 *
 * A time in the past is refused rather than clamped to `now`. Both readings
 * are defensible for a clock skewed by a second, and neither is defensible
 * for the one that matters — a timezone mistake that means yesterday — where
 * clamping silently mails the list immediately.
 */
export async function scheduleCampaign(
  actor: CampaignActor,
  id: string,
  raw: unknown,
): Promise<Result<Campaign>> {
  if (!can(actor.role, "campaigns.manage")) return DENIED;
  const p = ScheduleCampaignInput.safeParse(raw ?? {});
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const now = new Date();
  // No `scheduledAt` is "start now": due on the next sweep tick, not null.
  const at = p.data.scheduledAt ? new Date(p.data.scheduledAt) : now;
  if (at.getTime() < now.getTime())
    return {
      ok: false,
      code: "validation_error",
      error: "scheduledAt must be an ISO 8601 date-time in the future.",
      details: { field: "scheduledAt" },
    };
  const current = await getCampaign(actor.teamId, id);
  if (!current) return NOT_FOUND;
  if (!(EDITABLE_STATUSES as readonly string[]).includes(current.status))
    return {
      ok: false,
      code: "conflict",
      error: `A campaign that is ${current.status} cannot be scheduled.`,
    };
  const refs = await checkRefs(
    actor.teamId,
    current.bookId,
    current.domainId,
    current.from,
  );
  if (!refs.ok) return refs;
  const [row] = await db()
    .update(campaigns)
    .set({ status: "scheduled", scheduledAt: at })
    .where(
      and(
        eq(campaigns.id, current.id),
        eq(campaigns.teamId, actor.teamId),
        // Re-asserted, as in `updateCampaign`: the sweep can start a
        // `scheduled` campaign between the read above and this write, and
        // re-arming one that is already fanning out would give the sweep two
        // contradictory instructions about the same send.
        inArray(campaigns.status, [...EDITABLE_STATUSES]),
      ),
    )
    .returning();
  if (!row)
    return {
      ok: false,
      code: "conflict",
      error: "This campaign started sending while you were scheduling it.",
    };
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "campaigns.schedule",
    targetType: "campaign",
    targetId: row.id,
    diff: {
      status: { from: current.status, to: row.status },
      scheduledAt: {
        from: current.scheduledAt?.toISOString() ?? null,
        to: at.toISOString(),
      },
    },
  });
  return { ok: true, data: row };
}

/**
 * Un-arm a `scheduled` campaign, or stop a `sending` one.
 *
 * Two transitions, and they are deliberately not the same one:
 *
 * - **`scheduled` → `draft`.** Nothing has been sent, so there is nothing to
 *   record; the campaign goes back to being an editable draft. `scheduledAt`
 *   is cleared with it for the same reason an edit clears it — a draft that
 *   still carries a time makes the sweep (which selects on `status`) and the
 *   dashboard (which shows the time) describe two different futures.
 * - **`sending` → `cancelled`.** Mail has left. `cancelled` is a terminal,
 *   immutable status precisely so the row keeps saying so.
 *
 * Everything else is refused. `draft` has nothing to cancel, and `sent` and
 * `cancelled` are already at the end.
 *
 * ## What cancelling a `sending` campaign does *not* do
 *
 * It stops **further fan-out** and nothing more. The fan-out sweep selects
 * campaigns in `sending`, so a cancelled campaign materialises no further
 * recipients — but every recipient already materialised is an ordinary
 * `emails` row on the ordinary send path, and the ones already handed to SES
 * are gone. There is no recall in SES and there is none here.
 *
 * So `counts` is left exactly as it stands. Zeroing it would make the row
 * read as though nothing had been sent, which is the one thing a cancelled
 * campaign's operator must not believe: the numbers are the evidence of what
 * did go out, and they keep rising for a while afterwards as delivery and
 * open events land for mail that was already in flight. `sentAt` is likewise
 * untouched — the fan-out never finished, and stamping an end it did not
 * reach would be the same lie in a different column.
 */
export async function cancelCampaign(
  actor: CampaignActor,
  id: string,
): Promise<Result<Campaign>> {
  if (!can(actor.role, "campaigns.manage")) return DENIED;
  const current = await getCampaign(actor.teamId, id);
  if (!current) return NOT_FOUND;
  if (current.status !== "scheduled" && current.status !== "sending")
    return {
      ok: false,
      code: "conflict",
      error: `A campaign that is ${current.status} cannot be cancelled.`,
    };
  const to = current.status === "scheduled" ? "draft" : "cancelled";
  const [row] = await db()
    .update(campaigns)
    .set({
      status: to,
      // Only on the un-arming path: a cancelled send keeps the time it was
      // armed for, which is part of what happened.
      ...(to === "draft" && { scheduledAt: null }),
    })
    .where(
      and(
        eq(campaigns.id, current.id),
        eq(campaigns.teamId, actor.teamId),
        // The status this call decided on, re-asserted. Without it a sweep
        // that flips `scheduled` → `sending` between the read and the write
        // would see the campaign reverted to `draft` mid-fan-out — a draft
        // that is quietly still mailing people.
        eq(campaigns.status, current.status),
      ),
    )
    .returning();
  if (!row)
    return {
      ok: false,
      code: "conflict",
      error: "This campaign changed status while you were cancelling it.",
    };
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "campaigns.cancel",
    targetType: "campaign",
    targetId: row.id,
    diff: { status: { from: current.status, to: row.status } },
  });
  return { ok: true, data: row };
}
