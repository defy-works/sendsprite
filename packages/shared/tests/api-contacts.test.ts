import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ContactBookObject,
  ContactObject,
  CreateContactBookInput,
  CreateContactInput,
  ImportContactsInput,
  ImportContactsResult,
  ListContactsQuery,
  MAX_IMPORT_CSV_CHARS,
  UnsubscribeContactInput,
  UnsubscribeResult,
  UpdateContactBookInput,
  UpdateContactInput,
} from "../src/index";

describe("CreateContactBookInput", () => {
  it("requires a name and accepts an optional default from-address", () => {
    expect(CreateContactBookInput.parse({ name: " Newsletter " })).toEqual({
      name: "Newsletter",
    });
    expect(
      CreateContactBookInput.safeParse({
        name: "n",
        defaultFrom: "not an address",
      }).success,
    ).toBe(false);
    expect(
      CreateContactBookInput.safeParse({
        name: "n",
        defaultFrom: "Acme <a@b.io>",
      }).success,
    ).toBe(true);
    expect(CreateContactBookInput.safeParse({ name: "" }).success).toBe(false);
  });
});

describe("UpdateContactBookInput", () => {
  it("needs at least one field and can clear the default from-address", () => {
    expect(UpdateContactBookInput.safeParse({}).success).toBe(false);
    expect(UpdateContactBookInput.parse({ defaultFrom: null })).toEqual({
      defaultFrom: null,
    });
    expect(
      UpdateContactBookInput.safeParse({ defaultFrom: "nope" }).success,
    ).toBe(false);
  });
});

describe("CreateContactInput", () => {
  it("normalises the address and defaults subscribed to true", () => {
    expect(CreateContactInput.parse({ email: "  A@B.IO " })).toEqual({
      email: "a@b.io",
      subscribed: true,
      properties: {},
    });
  });

  it("rejects a bad address and over-long property values", () => {
    expect(CreateContactInput.safeParse({ email: "nope" }).success).toBe(false);
    expect(
      CreateContactInput.safeParse({
        email: "a@b.io",
        properties: { plan: "x".repeat(501) },
      }).success,
    ).toBe(false);
  });

  it("caps the number of properties", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(
      CreateContactInput.safeParse({ email: "a@b.io", properties }).success,
    ).toBe(false);
    expect(
      CreateContactInput.safeParse({
        email: "a@b.io",
        properties: Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [`k${i}`, "v"]),
        ),
      }).success,
    ).toBe(true);
  });
});

describe("UpdateContactInput", () => {
  it("needs at least one field and can flip subscription", () => {
    expect(UpdateContactInput.safeParse({}).success).toBe(false);
    expect(UpdateContactInput.parse({ subscribed: false })).toEqual({
      subscribed: false,
    });
  });

  it("cannot carry a suppression: the unknown key is stripped, not honoured", () => {
    expect(
      UpdateContactInput.parse({ subscribed: false, suppress: true }),
    ).toEqual({ subscribed: false });
  });
});

describe("ListContactsQuery", () => {
  it("carries the page params plus a search term and a subscription filter", () => {
    expect(
      ListContactsQuery.parse({ q: " ac ", subscribed: "false" }),
    ).toMatchObject({
      limit: 25,
      q: "ac",
      subscribed: false,
    });
  });

  it("leaves the filter off when it is absent and refuses anything else", () => {
    expect(ListContactsQuery.parse({}).subscribed).toBeUndefined();
    expect(ListContactsQuery.safeParse({ subscribed: "yes" }).success).toBe(
      false,
    );
  });
});

describe("ImportContactsInput", () => {
  it("requires csv text and defaults the flags", () => {
    expect(ImportContactsInput.parse({ csv: "email\na@b.io" })).toEqual({
      csv: "email\na@b.io",
      updateExisting: true,
    });
    expect(ImportContactsInput.safeParse({ csv: "" }).success).toBe(false);
    expect(
      ImportContactsInput.safeParse({ csv: "x".repeat(2 * 1024 * 1024 + 1) })
        .success,
    ).toBe(false);
  });

  it("tells an over-sized import exactly what to do about it", () => {
    const r = ImportContactsInput.safeParse({
      csv: "x".repeat(MAX_IMPORT_CSV_CHARS + 1),
    });
    expect(r.success).toBe(false);
    const message = r.error!.issues[0]!.message;
    expect(message).toContain("2 MB");
    expect(message).toMatch(/split/i);
    // The customer must be able to tell that splitting loses nothing.
    expect(message).toMatch(/same book/i);
  });
});

describe("ImportContactsResult", () => {
  it("parses the counts and the capped error list", () => {
    expect(
      ImportContactsResult.safeParse({
        imported: 2,
        updated: 1,
        skipped: 1,
        duplicates: 1,
        errors: [{ line: 4, email: "bad", reason: "invalid email" }],
      }).success,
    ).toBe(true);
  });

  it("caps the reported errors at 100", () => {
    const errors = Array.from({ length: 101 }, (_, i) => ({
      line: i + 2,
      email: null,
      reason: "invalid email",
    }));
    expect(
      ImportContactsResult.safeParse({
        imported: 0,
        updated: 0,
        skipped: 101,
        duplicates: 0,
        errors,
      }).success,
    ).toBe(false);
  });
});

describe("UnsubscribeContactInput", () => {
  it("takes an address, an optional book and an optional reason", () => {
    expect(UnsubscribeContactInput.parse({ email: "A@B.io" })).toEqual({
      email: "a@b.io",
    });
    expect(UnsubscribeContactInput.safeParse({ email: "x" }).success).toBe(
      false,
    );
    expect(
      UnsubscribeContactInput.parse({
        email: "a@b.io",
        bookId: "cb_1",
        reason: "link",
      }),
    ).toEqual({ email: "a@b.io", bookId: "cb_1", reason: "link" });
  });

  /**
   * Unsubscribing is consent, suppressing is deliverability. A caller must not
   * be able to smuggle "and never mail this address again" through the consent
   * endpoint, and an implementer must not find a field here inviting them to.
   */
  it("has no way to ask for a suppression", () => {
    expect(
      UnsubscribeContactInput.parse({
        email: "a@b.io",
        suppress: true,
        addSuppression: true,
        global: true,
      }),
    ).toEqual({ email: "a@b.io" });
    expect(Object.keys(UnsubscribeContactInput.shape)).toEqual([
      "email",
      "bookId",
      "reason",
    ]);
  });

  it("reports how many contact rows changed, and nothing about suppressions", () => {
    expect(UnsubscribeResult.parse({ unsubscribed: 0 })).toEqual({
      unsubscribed: 0,
    });
    expect(Object.keys(UnsubscribeResult.shape)).toEqual(["unsubscribed"]);
  });
});

describe("ContactObject", () => {
  it("parses what the REST layer returns", () => {
    expect(
      ContactObject.safeParse({
        id: "ct_1",
        bookId: "cb_1",
        email: "a@b.io",
        firstName: null,
        lastName: null,
        properties: {},
        subscribed: false,
        unsubscribeReason: "link",
        unsubscribedAt: "2026-08-26T00:00:00.000Z",
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

describe("ContactBookObject", () => {
  it("parses a book with its two counts", () => {
    expect(
      ContactBookObject.safeParse({
        id: "cb_1",
        name: "Newsletter",
        defaultFrom: null,
        contactCount: 2,
        subscribedCount: 1,
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

describe("the consent/deliverability boundary", () => {
  /**
   * The contacts contract must not reach for the suppression contract. If a
   * later change makes it, the two concepts have started merging in the one
   * place where the merge is invisible — a shared schema — and the review that
   * catches it is this test.
   */
  it("does not import the suppression contract", () => {
    const src = readFileSync(
      new URL("../src/api/contacts.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/from "\.\/suppressions"/);
    // It may still *explain* the distinction; that is the point of the file.
    expect(src).toMatch(/suppression/i);
  });
});

describe("OpenAPI representability", () => {
  it("emits every contact schema as JSON Schema in both views", () => {
    for (const schema of [
      CreateContactBookInput,
      UpdateContactBookInput,
      ContactBookObject,
      CreateContactInput,
      UpdateContactInput,
      ContactObject,
      ImportContactsInput,
      ImportContactsResult,
      UnsubscribeContactInput,
      UnsubscribeResult,
    ])
      for (const io of ["input", "output"] as const)
        expect(() =>
          z.toJSONSchema(schema, { unrepresentable: "any", io }),
        ).not.toThrow();
  });
});
