import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
let secret: string;
let sendingOnly: string;
beforeAll(async () => {
  pg = await startPg();
  secret = (await seedTeamWithKey()).secret;
  sendingOnly = (await seedTeamWithKey({ permission: "sending_only" })).secret;
});
afterAll(async () => {
  await pg.stop();
});

const BOOKS = "http://localhost/api/v1/contact-books";
const UNSUBSCRIBE = "http://localhost/api/v1/contacts/unsubscribe";
const req = (method: string, url: string, key?: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: {
      ...(key && { authorization: `Bearer ${key}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = (p: Record<string, string> = {}) => ({
  params: Promise.resolve(p),
});

async function newBook(): Promise<string> {
  const list = await import("@/app/api/v1/contact-books/route");
  const res = await list.POST(
    req("POST", BOOKS, secret, { name: `Book ${Math.random()}` }),
    params(),
  );
  return ((await res.json()) as { id: string }).id;
}

describe("REST /api/v1/contact-books", () => {
  it("401 without a key and 403 for a sending-only key", async () => {
    const list = await import("@/app/api/v1/contact-books/route");
    const uns = await import("@/app/api/v1/contacts/unsubscribe/route");
    expect((await list.GET(req("GET", BOOKS), params())).status).toBe(401);
    expect(
      (await list.GET(req("GET", BOOKS, sendingOnly), params())).status,
    ).toBe(403);
    expect(
      (
        await uns.POST(
          req("POST", UNSUBSCRIBE, sendingOnly, { email: "a@b.io" }),
          params(),
        )
      ).status,
    ).toBe(403);
  });

  it("creates a book (201) with counts, lists it, patches and deletes it", async () => {
    const list = await import("@/app/api/v1/contact-books/route");
    const one = await import("@/app/api/v1/contact-books/[id]/route");
    const created = await list.POST(
      req("POST", BOOKS, secret, { name: "News" }),
      params(),
    );
    expect(created.status).toBe(201);
    const book = (await created.json()) as { id: string };
    expect(book).toMatchObject({
      name: "News",
      contactCount: 0,
      subscribedCount: 0,
    });
    const page = await list.GET(req("GET", BOOKS, secret), params());
    expect(page.status).toBe(200);
    const patched = await one.PATCH(
      req("PATCH", BOOKS, secret, { name: "Newsletter" }),
      params({ id: book.id }),
    );
    expect(await patched.json()).toMatchObject({ name: "Newsletter" });
    expect(
      (await one.DELETE(req("DELETE", BOOKS, secret), params({ id: book.id })))
        .status,
    ).toBe(204);
    expect(
      (await one.GET(req("GET", BOOKS, secret), params({ id: book.id })))
        .status,
    ).toBe(404);
  });

  it("400s a body that is not JSON and 404s an unknown book", async () => {
    const list = await import("@/app/api/v1/contact-books/route");
    const one = await import("@/app/api/v1/contact-books/[id]/route");
    const bad = await list.POST(
      new Request(BOOKS, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: "{",
      }),
      params(),
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "validation_error" },
    });
    const missing = await one.PATCH(
      req("PATCH", BOOKS, secret, { name: "Nope" }),
      params({ id: "cb_missing" }),
    );
    expect(missing.status).toBe(404);
  });

  it("creates, lists, searches, patches and deletes contacts under a book", async () => {
    const many = await import("@/app/api/v1/contact-books/[id]/contacts/route");
    const one =
      await import("@/app/api/v1/contact-books/[id]/contacts/[contactId]/route");
    const id = await newBook();
    const url = `${BOOKS}/${id}/contacts`;
    const created = await many.POST(
      req("POST", url, secret, { email: "Ada@B.io", firstName: "Ada" }),
      params({ id }),
    );
    expect(created.status).toBe(201);
    const contact = (await created.json()) as { id: string; email: string };
    expect(contact.email).toBe("ada@b.io");

    const dupe = await many.POST(
      req("POST", url, secret, { email: "ada@b.io" }),
      params({ id }),
    );
    expect(dupe.status).toBe(409);

    const found = await many.GET(
      req("GET", `${url}?q=ada`, secret),
      params({ id }),
    );
    expect((await found.json()) as { data: unknown[] }).toMatchObject({
      data: [{ email: "ada@b.io" }],
    });
    const none = await many.GET(
      req("GET", `${url}?subscribed=false`, secret),
      params({ id }),
    );
    expect((await none.json()) as { data: unknown[] }).toMatchObject({
      data: [],
    });
    const badQuery = await many.GET(
      req("GET", `${url}?subscribed=maybe`, secret),
      params({ id }),
    );
    expect(badQuery.status).toBe(400);

    const fetched = await one.GET(
      req("GET", url, secret),
      params({ id, contactId: contact.id }),
    );
    expect(fetched.status).toBe(200);

    const patched = await one.PATCH(
      req("PATCH", url, secret, { subscribed: false }),
      params({ id, contactId: contact.id }),
    );
    expect(await patched.json()).toMatchObject({ subscribed: false });
    expect(
      (
        await one.DELETE(
          req("DELETE", url, secret),
          params({ id, contactId: contact.id }),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await one.GET(
          req("GET", url, secret),
          params({ id, contactId: contact.id }),
        )
      ).status,
    ).toBe(404);
  });

  it("imports a CSV and reports counts and per-row errors", async () => {
    const imp =
      await import("@/app/api/v1/contact-books/[id]/contacts/import/route");
    const id = await newBook();
    const res = await imp.POST(
      req("POST", `${BOOKS}/${id}/contacts/import`, secret, {
        csv: "email,first_name\nada@b.io,Ada\nbroken,X\n",
      }),
      params({ id }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      imported: 1,
      updated: 0,
      skipped: 1,
      duplicates: 0,
      errors: [{ line: 3, email: "broken" }],
    });
  });

  it("404s an import into a book that does not exist", async () => {
    const imp =
      await import("@/app/api/v1/contact-books/[id]/contacts/import/route");
    const res = await imp.POST(
      req("POST", `${BOOKS}/cb_missing/contacts/import`, secret, {
        csv: "email\nada@b.io\n",
      }),
      params({ id: "cb_missing" }),
    );
    expect(res.status).toBe(404);
  });

  it("refuses an import body larger than the route's own cap", async () => {
    const imp =
      await import("@/app/api/v1/contact-books/[id]/contacts/import/route");
    const id = await newBook();
    const request = new Request(`${BOOKS}/${id}/contacts/import`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "content-length": String(64 * 1024 * 1024),
      },
      body: JSON.stringify({ csv: "email\na@b.io" }),
    });
    const res = await imp.POST(request, params({ id }));
    expect(res.status).toBe(413);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "payload_too_large" },
    });
  });

  it("unsubscribes by address across the team and never writes a suppression", async () => {
    const { db } = await import("@/db");
    const { suppressions } = await import("@/db/schema");
    const many = await import("@/app/api/v1/contact-books/[id]/contacts/route");
    const uns = await import("@/app/api/v1/contacts/unsubscribe/route");
    const a = await newBook();
    const b = await newBook();
    for (const id of [a, b])
      await many.POST(
        req("POST", `${BOOKS}/${id}/contacts`, secret, { email: "x@y.io" }),
        params({ id }),
      );
    const res = await uns.POST(
      req("POST", UNSUBSCRIBE, secret, {
        email: "X@Y.io",
        reason: "link",
      }),
      params(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unsubscribed: 2 });
    expect(await db().select().from(suppressions)).toEqual([]);

    // Idempotent: the same address again changes nothing and is still a 200.
    const again = await uns.POST(
      req("POST", UNSUBSCRIBE, secret, { email: "x@y.io" }),
      params(),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ unsubscribed: 0 });
    expect(await db().select().from(suppressions)).toEqual([]);
  });
});
