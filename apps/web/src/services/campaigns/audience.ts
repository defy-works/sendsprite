import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import type { AudiencePreview } from "@sendsprite/shared";
import { db } from "@/db";
import { contacts, suppressions } from "@/db/schema";

/**
 * Who receives a campaign — the one place consent and deliverability meet.
 *
 * ## Eligible = subscribed (consent) AND not suppressed (deliverability)
 *
 * Both, not either. Phase 6 kept these two lists apart on purpose — leaving a
 * newsletter must not stop a password reset, and a hard bounce is not a
 * withdrawal of consent, so `contacts.subscribed` is per-book consent and
 * `suppressions` is a per-team "do not send at all" written by SES bounce and
 * complaint events. Campaign selection is the single read-time join where both
 * apply, because a campaign is exactly the kind of mail consent governs and
 * exactly the kind of volume that damages a sending reputation.
 *
 * Selection is not the last word on suppression: a hard bounce can arrive
 * between materialisation and the send, and the existing send path re-checks.
 * Those are two checks at two different times, not a duplicate (Decision 3).
 *
 * ## The suppression match is case-insensitive, and that is not defensive
 * ## programming
 *
 * `contacts.email` carries a check constraint — `email = lower(btrim(email))`
 * — so a contact address is normalised by the *table*. `suppressions.email`
 * carries no such constraint: it is a plain `text NOT NULL` whose only
 * normalisation is that every current writer happens to call `normaliseEmail`
 * or run the address through `AddSuppressionInput`. The unique index on
 * `(team_id, email)` compares raw bytes, so `A@b.io` and `a@b.io` are two
 * different rows to Postgres and both can exist at once.
 *
 * So `contacts.email = suppressions.email` is wrong: one mixed-case row from a
 * seed, a backfill, a restored dump or a future writer and **a suppressed
 * address gets mailed** — in campaign volume, which is how a customer loses
 * their SES reputation. The comparison is on `lower(btrim(...))` on both
 * sides, and `suppressions_team_lower_email_idx` is the index that serves it.
 *
 * ## Suppression is tested with `exists`, never joined
 *
 * Because duplicate-by-case rows are possible, a `left join` on the
 * lower-cased address can match one contact twice and inflate every count
 * derived from it. `exists` is a semi-join: it answers yes or no per contact,
 * once, whatever the suppression table holds.
 */

export type { AudiencePreview };

/** What the fan-out needs to build one recipient's `emails` row. */
export interface EligibleContact {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** Arbitrary per-contact keys, reachable in a body as `{{ properties.x }}`. */
  properties: Record<string, string>;
}

/**
 * `true` when this contact's address is on the team's suppression list.
 *
 * `lower(btrim(...))` on both sides: the left side is the indexed expression
 * on `suppressions`, and the right side re-normalises `contacts.email` even
 * though its check constraint already guarantees the shape — costing nothing
 * per row and surviving that constraint being relaxed.
 */
const isSuppressed = (teamId: string): SQL =>
  sql`exists (
        select 1 from ${suppressions}
        where ${suppressions.teamId} = ${teamId}
          and lower(btrim(${suppressions.email})) = lower(btrim(${contacts.email}))
      )`;

/**
 * One chunk of a book's eligible recipients, ordered by contact id ascending.
 *
 * Ids are ULIDs, so id order is insertion order: total, stable, and unique.
 * The cursor is a strict `>` on that same total order, which is what makes a
 * chunk boundary safe — `>=` would re-emit the boundary contact (a second
 * copy in someone's inbox, absorbed by the fan-out's unique index but only by
 * luck), and ordering by anything non-unique could skip a row when two rows
 * tie across the boundary.
 *
 * ## Known limitation: the audience is not frozen when the send starts
 *
 * Selection walks a cursor rather than materialising the whole audience up
 * front, so a book edited mid-send is read as it is *now*, not as it was at
 * `startedAt`. A contact added during a send sorts after the cursor and will
 * be mailed; a contact added with an id before the cursor — an out-of-order
 * ULID, a restored row, an import backdating ids — is silently missed. The
 * same goes for consent and suppression: unsubscribing mid-send takes effect
 * for the chunks not yet walked and not for the ones already materialised.
 *
 * This is accepted, not an oversight. Freezing the audience means writing
 * every recipient row before the first send (a 50 000-row transaction on a
 * cron tick) or snapshotting the book, and neither is worth it for a window
 * measured in the minutes a fan-out takes. It is a Phase 8 opener.
 */
export async function selectEligible(
  teamId: string,
  bookId: string,
  opts: { afterContactId?: string | null; limit: number },
): Promise<EligibleContact[]> {
  const where: SQL[] = [
    eq(contacts.teamId, teamId),
    eq(contacts.bookId, bookId),
    eq(contacts.subscribed, true),
    sql`not ${isSuppressed(teamId)}`,
  ];
  if (opts.afterContactId) where.push(gt(contacts.id, opts.afterContactId));
  return db()
    .select({
      id: contacts.id,
      email: contacts.email,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      properties: contacts.properties,
    })
    .from(contacts)
    .where(and(...where))
    .orderBy(asc(contacts.id))
    .limit(opts.limit);
}

/**
 * The four numbers on the audience card, all counted over contacts in the
 * book so no contact is ever counted twice:
 *
 * - `contacts` — every contact in the book, whatever their state.
 * - `subscribed` — of those, the ones who still consent (`subscribed = true`).
 * - `suppressed` — of those, the ones whose address is on the team's
 *   suppression list, counted once each regardless of consent and regardless
 *   of how many suppression rows match.
 * - `eligible` — of those, subscribed **and** not suppressed: the ones that
 *   will actually be mailed.
 *
 * `subscribed` and `suppressed` overlap, and `eligible` is a subset of
 * `subscribed` — they are four views of one population, not four buckets that
 * sum to it. A contact who is both unsubscribed and suppressed appears once in
 * `contacts`, once in `suppressed`, and in neither `subscribed` nor
 * `eligible`; the number the card can safely present as "excluded" is
 * `contacts - eligible`, which counts that contact once whichever way it is
 * excluded. The invariants that always hold are
 * `eligible <= subscribed <= contacts` and `suppressed <= contacts`.
 *
 * One aggregate over `contacts` with `filter` clauses, so all four numbers
 * come from a single scan and cannot disagree with each other.
 */
export async function audiencePreview(
  teamId: string,
  bookId: string,
): Promise<AudiencePreview> {
  const suppressed = isSuppressed(teamId);
  const [row] = await db()
    .select({
      contacts: sql<number>`count(*)::int`,
      subscribed: sql<number>`count(*) filter (where ${contacts.subscribed})::int`,
      suppressed: sql<number>`count(*) filter (where ${suppressed})::int`,
      eligible: sql<number>`count(*) filter (where ${contacts.subscribed} and not ${suppressed})::int`,
    })
    .from(contacts)
    .where(and(eq(contacts.teamId, teamId), eq(contacts.bookId, bookId)));
  // An ungrouped aggregate always returns one row; the fallback is for types.
  return row ?? { contacts: 0, subscribed: 0, suppressed: 0, eligible: 0 };
}
