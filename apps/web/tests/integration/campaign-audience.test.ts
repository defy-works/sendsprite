import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

interface Seeded {
  email: string;
  subscribed?: boolean;
  /** Written straight into `suppressions`, verbatim — case and all. */
  suppress?: string | true;
}

/**
 * A team with one book and the given contacts, plus any suppressions.
 *
 * Contact ids are `ct_<suffix><nn>` so lexicographic order is the seed order:
 * real ULIDs sort by creation time, and the cursor tests need that order to be
 * something they can state rather than observe.
 *
 * Suppressions are inserted with `db().insert(...)` rather than through
 * `services/suppressions.ts` **on purpose**: the service normalises, and the
 * whole question here is what happens when a row reaches the table without
 * having been normalised — which nothing in the schema prevents.
 */
async function seedBook(rows: Seeded[]) {
  const { db } = await import("@/db");
  const { contactBooks, contacts, suppressions } = await import("@/db/schema");
  const { newId } = await import("@sendsprite/shared");
  const suffix = randomBytes(4).toString("hex");
  const { team, actor } = await seedTeamWithKey();
  const bookId = `cb_${suffix}`;
  await db()
    .insert(contactBooks)
    .values({ id: bookId, teamId: team.id, name: "News" });
  const ids = rows.map((_, i) => `ct_${suffix}${String(i).padStart(2, "0")}`);
  await db()
    .insert(contacts)
    .values(
      rows.map((r, i) => ({
        id: ids[i]!,
        bookId,
        teamId: team.id,
        email: r.email,
        subscribed: r.subscribed ?? true,
      })),
    );
  const sup = rows.flatMap((r) =>
    r.suppress
      ? [
          {
            id: newId("sup"),
            teamId: team.id,
            email: r.suppress === true ? r.email : r.suppress,
            reason: "bounce" as const,
          },
        ]
      : [],
  );
  if (sup.length) await db().insert(suppressions).values(sup);
  return { db, team, actor, bookId, ids, suffix };
}

const audience = () => import("@/services/campaigns/audience");

describe("audience selection", () => {
  it("counts a subscribed, unsuppressed contact as eligible", async () => {
    const { team, bookId, ids } = await seedBook([{ email: "a@b.io" }]);
    const { audiencePreview, selectEligible } = await audience();
    expect(await audiencePreview(team.id, bookId)).toEqual({
      contacts: 1,
      subscribed: 1,
      suppressed: 0,
      eligible: 1,
    });
    expect(await selectEligible(team.id, bookId, { limit: 10 })).toMatchObject([
      { id: ids[0], email: "a@b.io" },
    ]);
  });

  it("excludes an unsubscribed contact", async () => {
    const { team, bookId } = await seedBook([
      { email: "in@b.io" },
      { email: "out@b.io", subscribed: false },
    ]);
    const { audiencePreview, selectEligible } = await audience();
    expect(await audiencePreview(team.id, bookId)).toEqual({
      contacts: 2,
      subscribed: 1,
      suppressed: 0,
      eligible: 1,
    });
    expect(
      (await selectEligible(team.id, bookId, { limit: 10 })).map(
        (c) => c.email,
      ),
    ).toEqual(["in@b.io"]);
  });

  it("excludes a suppressed contact even though it is subscribed", async () => {
    const { team, bookId } = await seedBook([
      { email: "in@b.io" },
      { email: "bounced@b.io", suppress: true },
    ]);
    const { audiencePreview, selectEligible } = await audience();
    expect(await audiencePreview(team.id, bookId)).toEqual({
      contacts: 2,
      subscribed: 2,
      suppressed: 1,
      eligible: 1,
    });
    expect(
      (await selectEligible(team.id, bookId, { limit: 10 })).map(
        (c) => c.email,
      ),
    ).toEqual(["in@b.io"]);
  });

  /*
   * The failure this whole module is shaped around. `contacts.email` is
   * lower-cased by a check constraint; `suppressions.email` is not constrained
   * at all, so a mixed-case row can sit in it. On a byte-equality join this
   * contact is eligible and gets mailed — a suppressed address, at campaign
   * volume. Assert the exclusion directly, with the row written straight to
   * the table so no service-layer normalisation can hide it.
   */
  it("matches suppression case-insensitively", async () => {
    const { team, bookId } = await seedBook([
      { email: "shouty@b.io", suppress: " Shouty@B.io " },
    ]);
    const { audiencePreview, selectEligible } = await audience();
    expect(await audiencePreview(team.id, bookId)).toEqual({
      contacts: 1,
      subscribed: 1,
      suppressed: 1,
      eligible: 0,
    });
    expect(await selectEligible(team.id, bookId, { limit: 10 })).toEqual([]);
  });

  /*
   * Testing the database, not the TypeScript: if `suppressions.email` ever
   * grows the same normalising check `contacts.email` has, the test above
   * starts passing for the wrong reason and the case-insensitive join looks
   * like dead weight. This states what each table actually guarantees, so the
   * day that changes, this fails and someone re-reads the join.
   */
  it("proves the schema does not normalise suppression addresses", async () => {
    const { sql } = await import("drizzle-orm");
    const checks = await pg.db.execute<{ table_name: string; def: string }>(
      sql`select rel.relname as table_name, pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          join pg_class rel on rel.oid = c.conrelid
          where c.contype = 'c' and rel.relname in ('contacts', 'suppressions')`,
    );
    // Contacts: normalised by the table.
    expect(
      checks.some(
        (r) =>
          r.table_name === "contacts" && /lower\(btrim\(email\)\)/.test(r.def),
      ),
    ).toBe(true);
    // Suppressions: nothing of the sort — hence the join.
    expect(checks.filter((r) => r.table_name === "suppressions")).toEqual([]);
    // And the expression index the case-insensitive join reads.
    const idx = await pg.db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes
          where tablename = 'suppressions'
            and indexname = 'suppressions_team_lower_email_idx'`,
    );
    expect(idx[0]?.indexdef).toMatch(/lower\(btrim\(email\)\)/);
  });

  /*
   * Two suppression rows that differ only in case are both insertable: the
   * unique index is on the raw bytes. A `left join` on `lower(email)` would
   * match this one contact twice and report `suppressed: 2` against
   * `contacts: 1` — arithmetic a customer can see is wrong. `exists` answers
   * once per contact.
   */
  it("counts a contact once when two suppressions differ only in case", async () => {
    const { team, bookId, db } = await seedBook([
      { email: "dup@b.io", suppress: "DUP@b.io" },
    ]);
    const { suppressions } = await import("@/db/schema");
    const { newId } = await import("@sendsprite/shared");
    await db()
      .insert(suppressions)
      .values({
        id: newId("sup"),
        teamId: team.id,
        email: "dup@b.io",
        reason: "complaint",
      });
    const { audiencePreview } = await audience();
    const p = await audiencePreview(team.id, bookId);
    expect(p).toEqual({
      contacts: 1,
      subscribed: 1,
      suppressed: 1,
      eligible: 0,
    });
    expect(p.suppressed).toBeLessThanOrEqual(p.contacts);
  });

  /*
   * The overlap case. `subscribed`, `suppressed` and `eligible` are three
   * views of one population, not three buckets, so the number that has to hold
   * is that each of them counts a contact at most once and that
   * `contacts - eligible` is the honest count of the excluded — one, not two,
   * for a contact excluded for both reasons at once.
   */
  it("counts a contact suppressed AND unsubscribed once, not twice", async () => {
    const { team, bookId } = await seedBook([
      { email: "ok@b.io" },
      { email: "both@b.io", subscribed: false, suppress: "BOTH@b.io" },
    ]);
    const { audiencePreview, selectEligible } = await audience();
    const p = await audiencePreview(team.id, bookId);
    expect(p).toEqual({
      contacts: 2,
      subscribed: 1,
      suppressed: 1,
      eligible: 1,
    });
    // Excluded once, not once per reason.
    expect(p.contacts - p.eligible).toBe(1);
    expect(p.eligible).toBeLessThanOrEqual(p.subscribed);
    expect(p.subscribed).toBeLessThanOrEqual(p.contacts);
    expect(p.suppressed).toBeLessThanOrEqual(p.contacts);
    expect(
      (await selectEligible(team.id, bookId, { limit: 10 })).map(
        (c) => c.email,
      ),
    ).toEqual(["ok@b.io"]);
    expect(p.eligible).toBe(
      (await selectEligible(team.id, bookId, { limit: 100 })).length,
    );
  });

  /*
   * The chunk boundary the fan-out walks. Two calls of `limit: 2` must return
   * four distinct contacts in seed order — not three (a skipped row) and not
   * an overlap (a second copy in someone's inbox).
   */
  it("selects in a stable order so the cursor cannot skip a contact", async () => {
    const { team, bookId, ids } = await seedBook(
      Array.from({ length: 5 }, (_, i) => ({ email: `c${i}@b.io` })),
    );
    const { selectEligible } = await audience();
    const first = await selectEligible(team.id, bookId, { limit: 2 });
    const second = await selectEligible(team.id, bookId, {
      afterContactId: first.at(-1)!.id,
      limit: 2,
    });
    const third = await selectEligible(team.id, bookId, {
      afterContactId: second.at(-1)!.id,
      limit: 2,
    });
    const walked = [...first, ...second, ...third].map((c) => c.id);
    expect(walked).toEqual(ids);
    expect(new Set(walked).size).toBe(5);
    // The walk ends rather than repeating its tail.
    expect(
      await selectEligible(team.id, bookId, {
        afterContactId: third.at(-1)!.id,
        limit: 2,
      }),
    ).toEqual([]);
    // Same cursor twice is the same answer: chunks are replayable.
    expect(
      (
        await selectEligible(team.id, bookId, {
          afterContactId: first.at(-1)!.id,
          limit: 2,
        })
      ).map((c) => c.id),
    ).toEqual(second.map((c) => c.id));
  });

  it("ignores a suppression belonging to another team", async () => {
    const { team, bookId, db } = await seedBook([{ email: "shared@b.io" }]);
    const other = await seedTeamWithKey();
    const { suppressions } = await import("@/db/schema");
    const { newId } = await import("@sendsprite/shared");
    await db()
      .insert(suppressions)
      .values({
        id: newId("sup"),
        teamId: other.team.id,
        email: "shared@b.io",
        reason: "bounce",
      });
    const { audiencePreview, selectEligible } = await audience();
    expect(await audiencePreview(team.id, bookId)).toMatchObject({
      suppressed: 0,
      eligible: 1,
    });
    expect(await selectEligible(team.id, bookId, { limit: 10 })).toHaveLength(
      1,
    );
  });

  it("selects only the named book, and only for its own team", async () => {
    const { team, bookId, db } = await seedBook([{ email: "mine@b.io" }]);
    const { contactBooks, contacts } = await import("@/db/schema");
    const { newId } = await import("@sendsprite/shared");
    const otherBook = newId("cb");
    await db()
      .insert(contactBooks)
      .values({ id: otherBook, teamId: team.id, name: "Other" });
    await db()
      .insert(contacts)
      .values({
        id: newId("ct"),
        bookId: otherBook,
        teamId: team.id,
        email: "theirs@b.io",
      });
    const { audiencePreview, selectEligible } = await audience();
    expect(await audiencePreview(team.id, bookId)).toMatchObject({
      contacts: 1,
      eligible: 1,
    });
    const stranger = await seedTeamWithKey();
    expect(await audiencePreview(stranger.team.id, bookId)).toEqual({
      contacts: 0,
      subscribed: 0,
      suppressed: 0,
      eligible: 0,
    });
    expect(
      await selectEligible(stranger.team.id, bookId, { limit: 10 }),
    ).toEqual([]);
  });
});
