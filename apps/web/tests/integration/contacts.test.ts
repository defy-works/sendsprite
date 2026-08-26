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

/** Contacts fan out webhook events; nothing here needs them delivered. */
const deps = { enqueue: async () => "job" };

async function book(name = "News") {
  const svc = await import("@/services/contacts");
  const { actor } = await seedTeamWithKey();
  const created = await svc.createBook(actor, { name });
  if (!created.ok) throw new Error("seed failed");
  return { actor, book: created.data, svc };
}

describe("contact books", () => {
  it("creates, lists with counts, updates and deletes", async () => {
    const { actor, book: b, svc } = await book();
    await svc.createContact(actor, b.id, { email: "a@b.io" }, deps);
    await svc.createContact(
      actor,
      b.id,
      { email: "c@d.io", subscribed: false },
      deps,
    );
    const [listed] = await svc.listBooks(actor.teamId);
    expect(listed).toMatchObject({
      id: b.id,
      contactCount: 2,
      subscribedCount: 1,
    });
    // The REST page carries the same counts as the dashboard list.
    const page = await svc.listBooksPage(actor.teamId, { limit: 25 });
    if (!page.ok) throw new Error("unreachable");
    expect(page.data.data).toMatchObject([
      { id: b.id, contactCount: 2, subscribedCount: 1 },
    ]);
    const renamed = await svc.updateBook(actor, b.id, { name: "Newsletter" });
    expect(renamed).toMatchObject({ ok: true });
    expect((await svc.deleteBook(actor, b.id)).ok).toBe(true);
    expect(await svc.listBooks(actor.teamId)).toEqual([]);
  });

  it("refuses a book from another team", async () => {
    const { book: b, svc } = await book();
    const other = await seedTeamWithKey();
    expect(
      await svc.updateBook(other.actor, b.id, { name: "x" }),
    ).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("needs settings.manage to delete a book", async () => {
    const { actor, book: b, svc } = await book();
    const member = { ...actor, role: "member" as const };
    expect(await svc.deleteBook(member, b.id)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });
});

describe("contacts", () => {
  it("normalises the address and refuses a duplicate in the same book", async () => {
    const { actor, book: b, svc } = await book();
    const c = await svc.createContact(actor, b.id, { email: " A@B.IO " }, deps);
    if (!c.ok) throw new Error("unreachable");
    expect(c.data.email).toBe("a@b.io");
    expect(
      await svc.createContact(actor, b.id, { email: "a@b.io" }, deps),
    ).toMatchObject({ ok: false, code: "conflict" });
  });

  it("refuses to write a contact into another team's book", async () => {
    const { book: b, svc } = await book();
    const other = await seedTeamWithKey();
    expect(
      await svc.createContact(other.actor, b.id, { email: "a@b.io" }, deps),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(
      await svc.importContacts(
        other.actor,
        b.id,
        { csv: "email\na@b.io" },
        deps,
      ),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("searches by address prefix and by name, and filters by subscription", async () => {
    const { actor, book: b, svc } = await book();
    await svc.createContact(
      actor,
      b.id,
      { email: "ada@b.io", firstName: "Ada" },
      deps,
    );
    await svc.createContact(
      actor,
      b.id,
      { email: "grace@b.io", firstName: "Grace", subscribed: false },
      deps,
    );
    const byQ = await svc.listContactsPage(actor.teamId, b.id, {
      limit: 25,
      q: "ada",
    });
    if (!byQ.ok) throw new Error("unreachable");
    expect(byQ.data.data.map((c) => c.email)).toEqual(["ada@b.io"]);
    const byName = await svc.listContactsPage(actor.teamId, b.id, {
      limit: 25,
      q: "grac",
    });
    if (!byName.ok) throw new Error("unreachable");
    expect(byName.data.data.map((c) => c.email)).toEqual(["grace@b.io"]);
    const subscribed = await svc.listContactsPage(actor.teamId, b.id, {
      limit: 25,
      subscribed: true,
    });
    if (!subscribed.ok) throw new Error("unreachable");
    expect(subscribed.data.data.map((c) => c.email)).toEqual(["ada@b.io"]);
    // A LIKE wildcard in the search term is a literal, not "match everything".
    const wildcard = await svc.listContactsPage(actor.teamId, b.id, {
      limit: 25,
      q: "%",
    });
    if (!wildcard.ok) throw new Error("unreachable");
    expect(wildcard.data.data).toEqual([]);
  });

  it("records unsubscribedAt on the way out and clears it on the way back in", async () => {
    const { actor, book: b, svc } = await book();
    const c = await svc.createContact(actor, b.id, { email: "a@b.io" }, deps);
    if (!c.ok) throw new Error("unreachable");
    const out = await svc.updateContact(
      actor,
      b.id,
      c.data.id,
      { subscribed: false, unsubscribeReason: "manual" },
      deps,
    );
    if (!out.ok) throw new Error("unreachable");
    expect(out.data.unsubscribedAt).toBeInstanceOf(Date);
    const back = await svc.updateContact(
      actor,
      b.id,
      c.data.id,
      { subscribed: true },
      deps,
    );
    if (!back.ok) throw new Error("unreachable");
    expect(back.data.unsubscribedAt).toBeNull();
    expect(back.data.unsubscribeReason).toBeNull();
  });

  it("will not update or delete a contact through another team's actor", async () => {
    const { actor, book: b, svc } = await book();
    const c = await svc.createContact(actor, b.id, { email: "a@b.io" }, deps);
    if (!c.ok) throw new Error("unreachable");
    const other = await seedTeamWithKey();
    expect(
      await svc.updateContact(
        other.actor,
        b.id,
        c.data.id,
        { subscribed: false },
        deps,
      ),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(await svc.deleteContact(other.actor, b.id, c.data.id)).toMatchObject(
      { ok: false, code: "not_found" },
    );
    expect(await svc.deleteContact(actor, b.id, c.data.id)).toMatchObject({
      ok: true,
    });
  });
});

describe("unsubscribe", () => {
  it("unsubscribes the address across every book of the team", async () => {
    const svc = await import("@/services/contacts");
    const { actor } = await seedTeamWithKey();
    const one = await svc.createBook(actor, { name: "One" });
    const two = await svc.createBook(actor, { name: "Two" });
    if (!one.ok || !two.ok) throw new Error("seed failed");
    await svc.createContact(actor, one.data.id, { email: "a@b.io" }, deps);
    await svc.createContact(actor, two.data.id, { email: "A@B.io" }, deps);
    const r = await svc.unsubscribeContact(actor, { email: "a@b.io" }, deps);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.unsubscribed).toBe(2);
    // Idempotent: nothing left to change.
    const again = await svc.unsubscribeContact(
      actor,
      { email: "a@b.io" },
      deps,
    );
    if (!again.ok) throw new Error("unreachable");
    expect(again.data.unsubscribed).toBe(0);
  });

  it("narrows to one book when asked", async () => {
    const svc = await import("@/services/contacts");
    const { actor } = await seedTeamWithKey();
    const one = await svc.createBook(actor, { name: "One" });
    const two = await svc.createBook(actor, { name: "Two" });
    if (!one.ok || !two.ok) throw new Error("seed failed");
    await svc.createContact(actor, one.data.id, { email: "a@b.io" }, deps);
    await svc.createContact(actor, two.data.id, { email: "a@b.io" }, deps);
    const r = await svc.unsubscribeContact(
      actor,
      { email: "a@b.io", bookId: one.data.id },
      deps,
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.unsubscribed).toBe(1);
  });

  it("writes NO suppression row — consent is not deliverability", async () => {
    const { db } = await import("@/db");
    const { suppressions } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { actor, book: b, svc } = await book();
    await svc.createContact(actor, b.id, { email: "a@b.io" }, deps);
    await svc.unsubscribeContact(actor, { email: "a@b.io" }, deps);
    expect(
      await db()
        .select()
        .from(suppressions)
        .where(eq(suppressions.teamId, actor.teamId)),
    ).toEqual([]);
  });

  it("leaves an existing suppression alone, and a suppression does not unsubscribe", async () => {
    const { db } = await import("@/db");
    const { contacts, suppressions } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { addSuppression } = await import("@/services/suppressions");
    const { actor, book: b, svc } = await book();
    await svc.createContact(actor, b.id, { email: "a@b.io" }, deps);
    // A bounce-shaped suppression is not a withdrawal of consent.
    const sup = await addSuppression(actor, {
      email: "a@b.io",
      reason: "manual",
    });
    expect(sup).toMatchObject({ ok: true });
    const [still] = await db()
      .select()
      .from(contacts)
      .where(eq(contacts.teamId, actor.teamId));
    expect(still?.subscribed).toBe(true);
    // And unsubscribing does not remove or add a suppression row.
    await svc.unsubscribeContact(actor, { email: "a@b.io" }, deps);
    const rows = await db()
      .select()
      .from(suppressions)
      .where(eq(suppressions.teamId, actor.teamId));
    expect(rows.map((s) => s.email)).toEqual(["a@b.io"]);
  });

  it("does not touch a contact of another team with the same address", async () => {
    const { actor, book: b, svc } = await book();
    const other = await book();
    await svc.createContact(actor, b.id, { email: "a@b.io" }, deps);
    await other.svc.createContact(
      other.actor,
      other.book.id,
      { email: "a@b.io" },
      deps,
    );
    await svc.unsubscribeContact(actor, { email: "a@b.io" }, deps);
    const theirs = await other.svc.listContactsPage(
      other.actor.teamId,
      other.book.id,
      { limit: 25 },
    );
    if (!theirs.ok) throw new Error("unreachable");
    expect(theirs.data.data[0]!.subscribed).toBe(true);
  });
});

describe("CSV import", () => {
  const csv = [
    "email,first_name,last_name,plan",
    "ada@b.io,Ada,Lovelace,pro",
    '"grace@b.io",Grace,Hopper,free',
    "not-an-email,X,Y,z",
    "ada@b.io,Ada,Second,scale",
  ].join("\n");

  it("imports, reports the bad row, and lets the last duplicate win", async () => {
    const { actor, book: b, svc } = await book();
    const r = await svc.importContacts(actor, b.id, { csv }, deps);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data).toMatchObject({
      imported: 2,
      updated: 0,
      skipped: 1,
      duplicates: 1,
    });
    expect(r.data.errors).toEqual([
      { line: 4, email: "not-an-email", reason: "Enter a valid email." },
    ]);
    const page = await svc.listContactsPage(actor.teamId, b.id, { limit: 25 });
    if (!page.ok) throw new Error("unreachable");
    const ada = page.data.data.find((c) => c.email === "ada@b.io");
    expect(ada).toMatchObject({
      firstName: "Ada",
      lastName: "Second",
      properties: { plan: "scale" },
    });
    // `teamId` is denormalised from the book; it must never come from anywhere else.
    expect(page.data.data.every((c) => c.teamId === actor.teamId)).toBe(true);
  });

  it("updates existing contacts by default and leaves them alone when told not to", async () => {
    const { actor, book: b, svc } = await book();
    await svc.createContact(
      actor,
      b.id,
      { email: "ada@b.io", firstName: "Old" },
      deps,
    );
    const kept = await svc.importContacts(
      actor,
      b.id,
      { csv: "email,first_name\nada@b.io,New", updateExisting: false },
      deps,
    );
    if (!kept.ok) throw new Error("unreachable");
    expect(kept.data).toMatchObject({ imported: 0, updated: 0, skipped: 1 });
    const updated = await svc.importContacts(
      actor,
      b.id,
      { csv: "email,first_name\nada@b.io,New" },
      deps,
    );
    if (!updated.ok) throw new Error("unreachable");
    expect(updated.data).toMatchObject({ imported: 0, updated: 1 });
  });

  it("re-importing an address does not resubscribe someone who opted out", async () => {
    const { actor, book: b, svc } = await book();
    await svc.createContact(actor, b.id, { email: "ada@b.io" }, deps);
    await svc.unsubscribeContact(actor, { email: "ada@b.io" }, deps);
    const r = await svc.importContacts(
      actor,
      b.id,
      { csv: "email,first_name\nada@b.io,Ada" },
      deps,
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data).toMatchObject({ imported: 0, updated: 1 });
    const page = await svc.listContactsPage(actor.teamId, b.id, { limit: 25 });
    if (!page.ok) throw new Error("unreachable");
    expect(page.data.data[0]).toMatchObject({
      firstName: "Ada",
      subscribed: false,
    });
    expect(page.data.data[0]!.unsubscribedAt).toBeInstanceOf(Date);
  });

  it("honours a subscribed column on the way in, and never resubscribes on the way back", async () => {
    const { actor, book: b, svc } = await book();
    // Already out, and the file says otherwise: the file does not win.
    await svc.createContact(actor, b.id, { email: "gone@b.io" }, deps);
    await svc.unsubscribeContact(actor, { email: "gone@b.io" }, deps);
    const r = await svc.importContacts(
      actor,
      b.id,
      {
        csv: [
          "email,first_name,subscribed,unsubscribe_reason",
          "ada@b.io,Ada,true,",
          "grace@b.io,Grace,FALSE,left the list",
          "hedy@b.io,Hedy,no,",
          "gone@b.io,Gone,true,",
        ].join("\n"),
      },
      deps,
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data).toMatchObject({ imported: 3, updated: 1, errors: [] });
    const page = await svc.listContactsPage(actor.teamId, b.id, { limit: 25 });
    if (!page.ok) throw new Error("unreachable");
    const by = new Map(page.data.data.map((c) => [c.email, c]));
    expect(by.get("ada@b.io")).toMatchObject({ subscribed: true });
    expect(by.get("ada@b.io")!.unsubscribedAt).toBeNull();
    // Arrived unsubscribed: stamped, with the file's reason carried through.
    expect(by.get("grace@b.io")).toMatchObject({
      subscribed: false,
      unsubscribeReason: "left the list",
    });
    expect(by.get("grace@b.io")!.unsubscribedAt).toBeInstanceOf(Date);
    expect(by.get("hedy@b.io")).toMatchObject({
      subscribed: false,
      unsubscribeReason: "import",
    });
    // Already unsubscribed, file says true: still out, name still updated.
    expect(by.get("gone@b.io")).toMatchObject({
      subscribed: false,
      firstName: "Gone",
    });
  });

  it("holds back a row whose subscribed cell means nothing recognisable", async () => {
    const { actor, book: b, svc } = await book();
    const r = await svc.importContacts(
      actor,
      b.id,
      {
        csv: [
          "email,subscribed",
          "ada@b.io,true",
          "grace@b.io,maybe later",
        ].join("\n"),
      },
      deps,
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data).toMatchObject({ imported: 1, skipped: 1 });
    expect(r.data.errors).toEqual([
      {
        line: 3,
        email: "grace@b.io",
        reason: 'Value in column "subscribed" must be true or false.',
      },
    ]);
  });

  it("round-trips its own export shape without inventing properties", async () => {
    const { actor, book: b, svc } = await book();
    const r = await svc.importContacts(
      actor,
      b.id,
      {
        csv: [
          "email,first_name,last_name,subscribed,unsubscribe_reason,created_at,plan",
          "ada@b.io,Ada,Lovelace,true,,2020-01-01T00:00:00.000Z,pro",
        ].join("\n"),
      },
      deps,
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data).toMatchObject({ imported: 1, errors: [] });
    const page = await svc.listContactsPage(actor.teamId, b.id, { limit: 25 });
    if (!page.ok) throw new Error("unreachable");
    const ada = page.data.data[0]!;
    // The reserved headers are fields; only `plan` is a property.
    expect(ada.properties).toEqual({ plan: "pro" });
    // `created_at` is ours to assign, not the file's to set.
    expect(ada.createdAt.getFullYear()).toBeGreaterThan(2020);
  });

  it("reports the rows the parser held back, and counts them as skipped", async () => {
    const { actor, book: b, svc } = await book();
    const r = await svc.importContacts(
      actor,
      b.id,
      {
        csv: [
          "email,first_name",
          "ada@b.io,Ada",
          "grace@b.io,Grace,extra,values",
          `long@b.io,${"x".repeat(501)}`,
        ].join("\n"),
      },
      deps,
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data).toMatchObject({ imported: 1, updated: 0, skipped: 2 });
    expect(
      r.data.errors.map((e) => ({ line: e.line, email: e.email })),
    ).toEqual([
      { line: 3, email: null },
      { line: 4, email: null },
    ]);
    expect(r.data.errors[0]!.reason).toMatch(/header has 2/);
    expect(r.data.errors[1]!.reason).toMatch(/longer than 500/);
  });

  it("truncates the error report and says how many rows it left out", async () => {
    const { actor, book: b, svc } = await book();
    const rows = Array.from({ length: 150 }, (_, i) => `bad-${i},X`);
    const r = await svc.importContacts(
      actor,
      b.id,
      { csv: ["email,first_name", "ada@b.io,Ada", ...rows].join("\n") },
      deps,
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data).toMatchObject({ imported: 1, skipped: 150 });
    // The response contract caps the array at 100 entries; every bad row is
    // still counted, and the last entry says how many are not listed.
    expect(r.data.errors).toHaveLength(100);
    expect(r.data.errors.at(-1)).toMatchObject({ email: null });
    expect(r.data.errors.at(-1)!.reason).toContain("51 more");
  });

  it("refuses a CSV with no email column, and one that is malformed", async () => {
    const { actor, book: b, svc } = await book();
    expect(
      await svc.importContacts(actor, b.id, { csv: "name\nAda" }, deps),
    ).toMatchObject({ ok: false, code: "validation_error" });
    expect(
      await svc.importContacts(
        actor,
        b.id,
        { csv: 'email\n"never closed' },
        deps,
      ),
    ).toMatchObject({ ok: false, code: "validation_error" });
  });

  it("collapses a duplicate inside one chunk instead of failing the statement", async () => {
    const { actor, book: b, svc } = await book();
    // Postgres refuses ON CONFLICT DO UPDATE twice on one key in one
    // statement, so the same address twice in a file must not reach it.
    const rows = ["email,first_name"];
    for (let i = 0; i < 600; i++) rows.push(`dupe@b.io,Name ${i}`);
    const r = await svc.importContacts(
      actor,
      b.id,
      { csv: rows.join("\n") },
      deps,
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data).toMatchObject({
      imported: 1,
      updated: 0,
      duplicates: 599,
      errors: [],
    });
    const page = await svc.listContactsPage(actor.teamId, b.id, { limit: 25 });
    if (!page.ok) throw new Error("unreachable");
    expect(page.data.data).toHaveLength(1);
    expect(page.data.data[0]).toMatchObject({ firstName: "Name 599" });
  });

  it("writes one audit row for the whole import, not one per contact", async () => {
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const { actor, book: b, svc } = await book();
    await svc.importContacts(actor, b.id, { csv }, deps);
    const rows = await db()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.teamId, actor.teamId),
          eq(auditLog.action, "contacts.import"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("is gated on contacts.manage, not settings.manage", async () => {
    const { actor, book: b, svc } = await book();
    const member = { ...actor, role: "member" as const };
    expect(await svc.importContacts(member, b.id, { csv }, deps)).toMatchObject(
      { ok: true },
    );
  });
});
