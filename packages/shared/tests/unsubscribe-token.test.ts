import { describe, expect, it } from "vitest";
import { ID_PREFIXES, newId } from "../src/index";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  type UnsubscribeTokenClaims,
} from "../src/node";

const SECRET = "x".repeat(40);
const CONTACT = "ct_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CAMPAIGN = "cmp_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const decode = (token: string) =>
  Buffer.from(token, "base64url").toString("utf8");
const encode = (payload: string) =>
  Buffer.from(payload, "utf8").toString("base64url");
/** The three fields of a genuine token, so a test can rebuild a forged one. */
const fields = (token: string) =>
  decode(token).split(".") as [string, string, string];

describe("unsubscribe tokens", () => {
  it("round-trips", () => {
    const t = signUnsubscribeToken(CONTACT, CAMPAIGN, SECRET);
    expect(verifyUnsubscribeToken(t, SECRET)).toEqual({
      contactId: CONTACT,
      campaignId: CAMPAIGN,
    } satisfies UnsubscribeTokenClaims);
  });

  it("is URL-safe", () => {
    // It goes in a path segment and in a `List-Unsubscribe` header, where a
    // `+`, `/` or `=` would be re-encoded, line-wrapped or truncated.
    const t = signUnsubscribeToken(CONTACT, CAMPAIGN, SECRET);
    expect(t).toBe(encodeURIComponent(t));
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses a token signed with another secret", () => {
    const t = signUnsubscribeToken(CONTACT, CAMPAIGN, SECRET);
    expect(verifyUnsubscribeToken(t, "y".repeat(40))).toBeNull();
  });

  it("refuses a token whose contact id was swapped", () => {
    const t = signUnsubscribeToken(CONTACT, CAMPAIGN, SECRET);
    const [, campaignId, sig] = fields(t);
    const forged = encode(
      ["ct_01ARZ3NDEKTSV4RRFFQ69G5FAW", campaignId, sig].join("."),
    );
    expect(verifyUnsubscribeToken(forged, SECRET)).toBeNull();
  });

  it("refuses a token whose campaign id was swapped", () => {
    const t = signUnsubscribeToken(CONTACT, CAMPAIGN, SECRET);
    const [contactId, , sig] = fields(t);
    const forged = encode(
      [contactId, "cmp_01ARZ3NDEKTSV4RRFFQ69G5FAW", sig].join("."),
    );
    expect(verifyUnsubscribeToken(forged, SECRET)).toBeNull();
  });

  it("refuses every attempt to move the boundary between the signed fields", () => {
    const t = signUnsubscribeToken(CONTACT, CAMPAIGN, SECRET);
    const [, , sig] = fields(t);
    // The signature covers `"<contactId>.<campaignId>"`, so a packing that let
    // the same byte string be read with the boundary somewhere else would be
    // forgeable. Each of these decodes to a payload the signature would match
    // if the fields were re-split, and each must be refused.
    for (const payload of [
      [`${CONTACT}.${CAMPAIGN}`, "", sig].join("."),
      ["", `${CONTACT}.${CAMPAIGN}`, sig].join("."),
      `${CONTACT}.${CAMPAIGN}.${sig}.`,
      `.${CONTACT}.${CAMPAIGN}.${sig}`,
      `${CONTACT}.${CAMPAIGN}`,
    ])
      expect(verifyUnsubscribeToken(encode(payload), SECRET)).toBeNull();
    // Swapping the two ids is a different signed string, not a re-split.
    expect(
      verifyUnsubscribeToken(
        encode([CAMPAIGN, CONTACT, sig].join(".")),
        SECRET,
      ),
    ).toBeNull();
  });

  it("keeps the packing unambiguous: no id format may contain a dot", () => {
    // This is the assumption that makes dot-packing safe. If a future id
    // format ever admitted a `.`, this fails here rather than silently
    // turning the boundary into something an attacker can move.
    for (const prefix of ID_PREFIXES) {
      const id = newId(prefix);
      expect(id, prefix).not.toContain(".");
      expect(
        verifyUnsubscribeToken(
          signUnsubscribeToken(id, newId("cmp"), SECRET),
          SECRET,
        ),
      ).toEqual({ contactId: id, campaignId: expect.any(String) });
    }
  });

  it("refuses to sign an id containing a dot", () => {
    // Belt to the brace above: an id that could move the boundary must fail
    // loudly where it is introduced, not mint an unverifiable link.
    expect(() =>
      signUnsubscribeToken("ct_a.cmp_b", CAMPAIGN, SECRET),
    ).toThrow();
    expect(() => signUnsubscribeToken(CONTACT, "cmp_a.b", SECRET)).toThrow();
    expect(() => signUnsubscribeToken("", CAMPAIGN, SECRET)).toThrow();
    expect(() => signUnsubscribeToken(CONTACT, "", SECRET)).toThrow();
  });

  it("refuses an empty secret instead of signing with the empty key", () => {
    // `createHmac("sha256", "")` is legal in Node, so an unset `APP_SECRET`
    // would otherwise mint links anyone could forge.
    expect(() => signUnsubscribeToken(CONTACT, CAMPAIGN, "")).toThrow();
    const t = signUnsubscribeToken(CONTACT, CAMPAIGN, SECRET);
    expect(verifyUnsubscribeToken(t, "")).toBeNull();
  });

  it("refuses a non-canonical encoding of a valid token", () => {
    // base64 decoding is lenient, so many strings decode to the same bytes:
    // padding, whitespace, the non-url alphabet, and - because the payload is
    // not a multiple of three bytes - three alternative spellings of the final
    // character. A token must have exactly one spelling, or a cache or a
    // rate-limiter keyed on the raw token can be walked straight past.
    const t = signUnsubscribeToken(CONTACT, CAMPAIGN, SECRET);
    const bytes = Buffer.from(t, "base64url");
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const alternates = [...alphabet]
      .map((c) => `${t.slice(0, -1)}${c}`)
      .filter((v) => v !== t && Buffer.from(v, "base64url").equals(bytes));
    expect(alternates.length).toBeGreaterThan(0);
    for (const variant of [
      `${t}=`,
      `${t}
`,
      ` ${t}`,
      ...alternates,
    ])
      expect(verifyUnsubscribeToken(variant, SECRET), variant).toBeNull();
  });

  it("returns null for junk of every shape and never throws", () => {
    const junk: unknown[] = [
      "",
      "....",
      "not base64!!",
      "a",
      "a".repeat(5000),
      "%%%%",
      "\u0000",
      encode(""),
      encode("."),
      encode(".."),
      encode("..."),
      encode("a.b"), // two fields
      encode("a.b.c.d"), // four fields
      encode("a.b.c"), // three fields, junk signature
      encode(`${CONTACT}.${CAMPAIGN}.`), // empty signature
      encode(`${CONTACT}.${CAMPAIGN}.${"A".repeat(43)}`), // right-length sig
      encode("契約.キャンペーン.署名"), // unicode payload
      encode("🙂".repeat(100)),
      Buffer.from([0xff, 0xfe, 0x41]).toString("base64url"), // not utf-8
      null,
      undefined,
      42,
      {},
      [],
      ["ct", "cmp"],
    ];
    for (const value of junk)
      expect(() =>
        expect(
          verifyUnsubscribeToken(value as string, SECRET),
          String(value),
        ).toBeNull(),
      ).not.toThrow();
  });
});
