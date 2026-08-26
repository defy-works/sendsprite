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

describe("templates and contacts schema", () => {
  it("templates are unique per team by slug and cascade with the team", async () => {
    const { db } = await import("@/db");
    const { organization, templates } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    const row = {
      id: "tpl_a",
      teamId: team.id,
      slug: "welcome",
      name: "Welcome",
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
    };
    await db().insert(templates).values(row);
    await expect(
      db()
        .insert(templates)
        .values({ ...row, id: "tpl_b" }),
    ).rejects.toThrow();
    // The same slug in another team is a different template.
    const other = await seedTeamWithKey();
    await db()
      .insert(templates)
      .values({ ...row, id: "tpl_c", teamId: other.team.id });
    await db().delete(organization).where(eq(organization.id, team.id));
    expect(
      await db().select().from(templates).where(eq(templates.teamId, team.id)),
    ).toHaveLength(0);
  });

  it("template_versions are keyed on (template, version) and cascade with the template", async () => {
    const { db } = await import("@/db");
    const { templateVersions, templates } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    await db().insert(templates).values({
      id: "tpl_v",
      teamId: team.id,
      slug: "v",
      name: "V",
      subject: "s",
      bodyHtml: "b",
    });
    const snapshot = {
      name: "V",
      subject: "s",
      bodyHtml: "b",
      bodyText: null,
      variablesSchema: { variables: [] },
    };
    await db()
      .insert(templateVersions)
      .values({ templateId: "tpl_v", version: 1, snapshot });
    await expect(
      db()
        .insert(templateVersions)
        .values({ templateId: "tpl_v", version: 1, snapshot }),
    ).rejects.toThrow();
    await db().delete(templates).where(eq(templates.id, "tpl_v"));
    expect(await db().select().from(templateVersions)).toHaveLength(0);
  });

  it("contacts are unique per (book, email) and cascade with the book", async () => {
    const { db } = await import("@/db");
    const { contactBooks, contacts } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    await db()
      .insert(contactBooks)
      .values({ id: "cb_1", teamId: team.id, name: "News" });
    const row = {
      id: "ct_1",
      bookId: "cb_1",
      teamId: team.id,
      email: "a@b.io",
    };
    await db().insert(contacts).values(row);
    await expect(
      db()
        .insert(contacts)
        .values({ ...row, id: "ct_2" }),
    ).rejects.toThrow();
    await db().delete(contactBooks).where(eq(contactBooks.id, "cb_1"));
    expect(await db().select().from(contacts)).toHaveLength(0);
  });

  /*
   * The `(book_id, email)` unique index only delivers unsubscribe idempotency
   * and import dedupe if every writer stores the address in the *same*
   * normalised form the contract produces (`.trim().toLowerCase()`) — two rows
   * differing only in case are two rows to Postgres, so the second unsubscribe
   * call would find nothing and the import would insert a duplicate. The
   * contract normalises; this constraint is what stops a writer that bypasses
   * it (a seed, a backfill, a future service) from quietly breaking both.
   */
  it("refuses a contact address that is not already normalised", async () => {
    const { db } = await import("@/db");
    const { contactBooks, contacts } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    await db()
      .insert(contactBooks)
      .values({ id: "cb_n", teamId: team.id, name: "News" });
    for (const email of ["Mixed@Case.io", " a@b.io", "a@b.io "]) {
      await expect(
        db()
          .insert(contacts)
          .values({
            id: `ct_n_${email.length}`,
            bookId: "cb_n",
            teamId: team.id,
            email,
          }),
      ).rejects.toThrow();
    }
    await db().insert(contacts).values({
      id: "ct_n_ok",
      bookId: "cb_n",
      teamId: team.id,
      email: "mixed@case.io",
    });
  });

  it("emails carry a template reference that survives deleting the template", async () => {
    const { db } = await import("@/db");
    const { domains, emails, templates } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    await db().insert(templates).values({
      id: "tpl_e",
      teamId: team.id,
      slug: "e",
      name: "E",
      subject: "s",
      bodyHtml: "b",
    });
    await db()
      .insert(domains)
      .values({
        id: "dom_e",
        teamId: team.id,
        name: `d${Date.now()}.io`,
        region: "eu-west-1",
        dnsMode: "manual",
        mailFromDomain: "bounce.d.io",
      });
    await db()
      .insert(emails)
      .values({
        id: "em_e",
        teamId: team.id,
        domainId: "dom_e",
        from: "a@b.io",
        fromEmail: "a@b.io",
        to: ["c@d.io"],
        subject: "s",
        templateId: "tpl_e",
        variables: { name: "Mingu" },
      });
    await db().delete(templates).where(eq(templates.id, "tpl_e"));
    const [row] = await db().select().from(emails).where(eq(emails.id, "em_e"));
    expect(row?.templateId).toBeNull();
    expect(row?.variables).toEqual({ name: "Mingu" });
  });

  // Migration 0011 exists because a µs/ms mismatch silently skipped rows; the
  // billing schema test guards the same thing. Every column below is either
  // keyset-paged or ordered against a value that has been through a JS `Date`.
  it("stores millisecond precision on the paged timestamps", async () => {
    const { sql } = await import("drizzle-orm");
    const rows = await pg.db.execute(
      sql`select table_name, column_name, datetime_precision
          from information_schema.columns
          where table_schema = 'public'
            and (table_name, column_name) in (
              ('templates', 'created_at'),
              ('template_versions', 'created_at'),
              ('contact_books', 'created_at'),
              ('contacts', 'created_at')
            )
          order by table_name, column_name`,
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.datetime_precision).toBe(3);
  });
});
