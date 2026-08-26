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

/** A team with a domain, a book and one contact, all ids suffixed per test. */
async function seedAudience(suffix: string) {
  const { db } = await import("@/db");
  const { contactBooks, contacts, domains } = await import("@/db/schema");
  const { team } = await seedTeamWithKey();
  await db()
    .insert(domains)
    .values({
      id: `dom_${suffix}`,
      teamId: team.id,
      name: `${suffix}.example.test`,
      region: "eu-west-1",
      dnsMode: "manual",
      mailFromDomain: `bounce.${suffix}.example.test`,
    });
  await db()
    .insert(contactBooks)
    .values({ id: `cb_${suffix}`, teamId: team.id, name: "News" });
  await db()
    .insert(contacts)
    .values({
      id: `ct_${suffix}`,
      bookId: `cb_${suffix}`,
      teamId: team.id,
      email: `${suffix}@b.io`,
    });
  return { db, team };
}

/** A draft campaign over that audience. */
async function seedCampaign(suffix: string) {
  const { db, team } = await seedAudience(suffix);
  const { campaigns } = await import("@/db/schema");
  await db()
    .insert(campaigns)
    .values({
      id: `cmp_${suffix}`,
      teamId: team.id,
      bookId: `cb_${suffix}`,
      domainId: `dom_${suffix}`,
      name: "August news",
      subject: "Hello",
      from: `news@${suffix}.example.test`,
      blocks: [{ kind: "text", html: "Hi" }],
    });
  return { db, team };
}

describe("campaigns schema", () => {
  /*
   * Migration 0011 exists because a µs/ms mismatch silently skipped rows in
   * keyset pagination — the rows were there, the query stepped over them. The
   * query below deliberately selects *every* `timestamp with time zone` column
   * of the two new tables rather than a hand-written list, so a column added
   * later without `precision: 3` fails here instead of shipping. The name
   * assertion is what stops it passing vacuously on an empty result set.
   */
  it("stores every timestamp at millisecond precision", async () => {
    const { sql } = await import("drizzle-orm");
    const rows = await pg.db.execute(
      sql`select table_name, column_name, datetime_precision
          from information_schema.columns
          where table_schema = 'public'
            and table_name in ('campaigns', 'campaign_recipients')
            and data_type = 'timestamp with time zone'
          order by table_name, column_name`,
    );
    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      "campaign_recipients.created_at",
      "campaigns.created_at",
      "campaigns.scheduled_at",
      "campaigns.sent_at",
      "campaigns.started_at",
      "campaigns.updated_at",
    ]);
    for (const r of rows)
      expect(
        r.datetime_precision,
        `${r.table_name}.${r.column_name} must be timestamp(3)`,
      ).toBe(3);
  });

  /*
   * The double-send guard. Everything else about the fan-out — the cursor, the
   * chunk size, the sweep cadence — is an optimisation; this is the
   * correctness boundary, and it is what makes a retried or overlapping chunk
   * a no-op instead of a second copy in someone's inbox.
   */
  it("refuses a second recipient row for the same contact", async () => {
    const { db } = await seedCampaign("dup");
    const { campaignRecipients } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const row = { campaignId: "cmp_dup", contactId: "ct_dup" };
    await db().insert(campaignRecipients).values(row);
    await expect(db().insert(campaignRecipients).values(row)).rejects.toThrow();
    // Which is exactly why a re-run of the chunk may insert-and-ignore.
    const again = await db()
      .insert(campaignRecipients)
      .values(row)
      .onConflictDoNothing()
      .returning();
    expect(again).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(campaignRecipients)
        .where(eq(campaignRecipients.campaignId, "cmp_dup")),
    ).toHaveLength(1);
  });

  /*
   * `emails.campaign_id`/`contact_id` carry no foreign key on purpose: the
   * mail log outlives both, and an FK would either block the delete or cascade
   * the history away. A dangling id reads as "the campaign is gone".
   */
  it("keeps mail-log rows and their campaign ids when the campaign goes", async () => {
    const { db, team } = await seedCampaign("log");
    const { campaigns, contacts, emails } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db()
      .insert(emails)
      .values({
        id: "em_log",
        teamId: team.id,
        domainId: "dom_log",
        from: "news@log.example.test",
        fromEmail: "news@log.example.test",
        to: ["log@b.io"],
        subject: "Hello",
        source: "campaign",
        campaignId: "cmp_log",
        contactId: "ct_log",
      });
    await db().delete(campaigns).where(eq(campaigns.id, "cmp_log"));
    await db().delete(contacts).where(eq(contacts.id, "ct_log"));
    const [row] = await db()
      .select()
      .from(emails)
      .where(eq(emails.id, "em_log"));
    expect(row).toMatchObject({ campaignId: "cmp_log", contactId: "ct_log" });
  });

  /*
   * `book_id` and `domain_id` are FK-free for the same reason: `restrict`
   * would make deleting a book or a domain fail with an unhandled Postgres
   * error (neither `deleteBook` nor `deleteDomain` catches one), and `cascade`
   * would erase the record of a send that really happened. So the delete
   * succeeds, the campaign survives, and every reader must render a missing
   * book or domain rather than assume one.
   */
  it("survives deleting the book and domain it points at", async () => {
    const { db } = await seedCampaign("dangle");
    const { campaigns, contactBooks, domains } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db().delete(contactBooks).where(eq(contactBooks.id, "cb_dangle"));
    await db().delete(domains).where(eq(domains.id, "dom_dangle"));
    const [row] = await db()
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, "cmp_dangle"));
    expect(row).toMatchObject({
      bookId: "cb_dangle",
      domainId: "dom_dangle",
      status: "draft",
    });
    // The counts cache starts as the honest all-zero answer, not `{}`.
    expect(row?.counts.recipients).toBe(0);
  });

  /** Deleting the team is the one thing that takes a campaign with it. */
  it("cascades with the team", async () => {
    const { db, team } = await seedCampaign("casc");
    const { campaignRecipients, campaigns, organization } =
      await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db()
      .insert(campaignRecipients)
      .values({ campaignId: "cmp_casc", contactId: "ct_casc" });
    await db().delete(organization).where(eq(organization.id, team.id));
    expect(
      await db().select().from(campaigns).where(eq(campaigns.id, "cmp_casc")),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(campaignRecipients)
        .where(eq(campaignRecipients.campaignId, "cmp_casc")),
    ).toHaveLength(0);
  });
});
