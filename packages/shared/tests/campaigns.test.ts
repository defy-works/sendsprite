import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as campaigns from "../src/api/campaigns";
import {
  CampaignBlock,
  CreateCampaignInput,
  MAX_BLOCKS,
  MAX_URL_CHARS,
  SafeUrl,
  UpdateCampaignInput,
} from "../src/api/campaigns";

const text = (html: string) => CampaignBlock.safeParse({ kind: "text", html });
const url = (u: string) => SafeUrl.safeParse(u);

/**
 * Written as character codes rather than literals: a NUL and a non-breaking
 * space are invisible in a diff and the first tool to touch this file that is
 * careless about encodings turns them into something else, quietly weakening
 * the two tests that need them most.
 */
const NUL = String.fromCharCode(0);
const NBSP = String.fromCharCode(0xa0);

describe("CampaignBlock", () => {
  it("accepts each block kind", () => {
    const blocks = [
      { kind: "heading", level: 1, text: "Hello" },
      { kind: "text", html: "Hi <strong>there</strong>" },
      { kind: "button", label: "Read", url: "https://example.com" },
      { kind: "image", url: "https://example.com/a.png", alt: "A" },
      { kind: "divider" },
      { kind: "spacer", size: 24 },
    ];
    for (const b of blocks)
      expect(CampaignBlock.safeParse(b).success, JSON.stringify(b)).toBe(true);
  });

  it("refuses a javascript: URL on a button", () => {
    const r = CampaignBlock.safeParse({
      kind: "button",
      label: "Click",
      url: "javascript:alert(1)",
    });
    expect(r.success).toBe(false);
  });

  it("refuses a protocol-relative URL, which inherits the page scheme", () => {
    const r = CampaignBlock.safeParse({
      kind: "image",
      url: "//evil.test/a.png",
      alt: "x",
    });
    expect(r.success).toBe(false);
  });

  it("refuses control characters in heading text", () => {
    expect(
      CampaignBlock.safeParse({ kind: "heading", level: 2, text: "a\tb" })
        .success,
    ).toBe(false);
  });

  it("refuses a text block carrying markup the editor cannot emit", () => {
    expect(text("<script>x</script>").success).toBe(false);
    expect(text("<img src=x onerror=y>").success).toBe(false);
  });

  it("refuses an unknown discriminator", () => {
    expect(CampaignBlock.safeParse({ kind: "html", html: "x" }).success).toBe(
      false,
    );
  });
});

/*
 * `text.html` is the only field in the phase whose value reaches the rendered
 * email as markup rather than as escaped text, so these are the tests that
 * stand between the editor and a stored XSS.
 */
describe("text block inline HTML", () => {
  it("admits exactly the marks the editor emits", () => {
    for (const s of [
      "plain words, punctuation & ampersands",
      "<strong>bold</strong> and <em>italic</em>",
      "<strong><em>both</em></strong>",
      "line<br>break",
      "line<br/>break",
      "line<br />break",
      '<a href="https://example.com/p?a=1&b=2">link</a>',
      '<a href="http://example.com">link</a>',
      '<a href="mailto:a@example.com">mail</a>',
      "",
    ])
      expect(text(s).success, s).toBe(true);
  });

  it("refuses any attribute beside a well-formed href", () => {
    for (const s of [
      '<a href="https://x.test" onclick="alert(1)">z</a>',
      '<a href="https://x.test" style="x">z</a>',
      "<strong onclick=x>y</strong>",
      "<em class=y>z</em>",
      "<br onload=x>",
    ])
      expect(text(s).success, s).toBe(false);
  });

  it("refuses an href that is not http, https or mailto", () => {
    for (const s of [
      '<a href="javascript:alert(1)">z</a>',
      '<a href="data:text/html,x">z</a>',
      '<a href="httpsx://x.test">z</a>',
      "<a href='javascript:alert(1)'>z</a>",
      "<a href=https://x.test>z</a>",
      '<a href="/relative">z</a>',
    ])
      expect(text(s).success, s).toBe(false);
  });

  /*
   * Upper case is refused rather than folded: HTML tag names are
   * case-insensitive, so accepting `<A HREF=...>` would mean the allow-list
   * has to be case-insensitive too, and `href` would become one of several
   * spellings to keep straight. The editor emits lower case; anything else is
   * not the editor.
   */
  it("refuses upper-case tags rather than folding them", () => {
    for (const s of [
      "<STRONG>x</STRONG>",
      '<A HREF="https://x.test">z</A>',
      "<BR>",
    ])
      expect(text(s).success, s).toBe(false);
  });

  it("refuses a bare angle bracket, closed or not", () => {
    for (const s of ["a < b", "a > b", "<strong", "unclosed <", "<a href="])
      expect(text(s).success, s).toBe(false);
  });

  /*
   * The renderer injects this string without escaping, so an unclosed `<a>`
   * does not stop at the block: it swallows every following block into one
   * link, and an unclosed `<strong>` bolds the rest of the message. A pure
   * token allow-list happily admits both, which is why the structural check
   * exists alongside it.
   */
  it("refuses markup that does not close, so a block cannot bleed into the next", () => {
    for (const s of [
      'text <a href="https://x.test">no close',
      "text <strong>no close",
      "text </a>",
      "text </strong>",
      "<strong><em>mis</strong></em>",
    ])
      expect(text(s).success, s).toBe(false);
  });

  /*
   * A nested anchor is auto-closed by every HTML parser, so what is stored and
   * what is rendered stop agreeing.
   */
  it("refuses a nested anchor", () => {
    expect(
      text('<a href="https://x.test"><a href="https://y.test">z</a></a>')
        .success,
    ).toBe(false);
  });

  /*
   * `<a href="https://x&#x22; onclick=&#x22;alert(1)">` is one href as far as
   * the HTML tokeniser is concerned, but it is a payload shaped like an
   * attribute and it has no business in a URL. Banning whitespace inside the
   * href refuses it and every variant of it, because no real URL carries a
   * literal space.
   */
  it("refuses whitespace and path-mangling characters inside an href", () => {
    for (const s of [
      '<a href="https://x&#x22; onclick=&#x22;alert(1)">z</a>',
      '<a href="https://x.test/a b">z</a>',
      `<a href="https://x.test/a${NBSP}b">z</a>`,
      '<a href="https:/\\evil.test">z</a>',
    ])
      expect(text(s).success, s).toBe(false);
  });

  it("refuses control characters, which no editor emits", () => {
    expect(text(`a${NUL}b`).success).toBe(false);
    expect(text("a\nb").success).toBe(false);
  });
});

describe("SafeUrl", () => {
  it("accepts the three allowed schemes", () => {
    for (const u of [
      "https://example.com/a.png",
      "http://example.com",
      "mailto:a@example.com",
      "HTTPS://example.com",
    ])
      expect(url(u).success, u).toBe(true);
  });

  it("refuses a scheme that is not http, https or mailto", () => {
    for (const u of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "file:///etc/passwd",
    ])
      expect(url(u).success, u).toBe(false);
  });

  it("refuses anything that is not an absolute URL", () => {
    for (const u of ["//evil.test/a.png", "/a.png", "example.com", ""])
      expect(url(u).success, u).toBe(false);
  });

  /*
   * `https://example.com@evil.test/` is a perfectly valid URL pointing at
   * `evil.test`, and it reads as `example.com` to the recipient. No legitimate
   * campaign link carries credentials.
   */
  it("refuses embedded credentials, which read as a different host", () => {
    for (const u of [
      "https://example.com@evil.test/login",
      "https://user:pass@evil.test/",
      "https://user@evil.test/",
    ])
      expect(url(u).success, u).toBe(false);
  });

  /*
   * The refine validates `new URL(raw)` but the *raw* string is what gets
   * stored and rendered into `href="..."`. A quote in the raw string closes
   * that attribute; the URL parser never complains, because it percent-encodes
   * the quote on the way out and the parsed form looks perfectly ordinary.
   */
  it("refuses characters that would break out of an href attribute", () => {
    for (const u of [
      'https://x.test/" onmouseover="alert(1)',
      "https://x.test/' onmouseover='alert(1)",
      "https://x.test/`a`",
      "https://x.test/<img src=x onerror=y>",
      "https://x.test/a b",
      "https:/\\evil.test/",
    ])
      expect(url(u).success, u).toBe(false);
  });

  /*
   * The WHATWG parser silently strips tab and newline, so `ht<TAB>tps://x`
   * parses as `https:` and sails through a scheme check while the stored
   * string is something else entirely. Validate-normalised, store-raw is the
   * bug class; refusing the characters closes it.
   */
  it("refuses interior whitespace the URL parser would strip", () => {
    for (const u of ["ht\ttps://x.test/", "https://x.test/a\nb"])
      expect(url(u).success, u).toBe(false);
  });

  it("refuses control characters, which a URL must percent-encode", () => {
    expect(url(`https://x.test/a${NUL}b`).success).toBe(false);
  });

  it("caps the length", () => {
    expect(url(`https://x.test/${"a".repeat(MAX_URL_CHARS)}`).success).toBe(
      false,
    );
  });
});

describe("CreateCampaignInput", () => {
  const base = {
    name: "August newsletter",
    bookId: "cb_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    domainId: "dom_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    from: "Acme <hello@mail.acme.com>",
    subject: "What we shipped",
    blocks: [{ kind: "text", html: "Hello" }],
  };

  it("accepts a minimal campaign", () => {
    expect(CreateCampaignInput.safeParse(base).success).toBe(true);
  });

  it("refuses a subject with a tab, like every other send path", () => {
    const r = CreateCampaignInput.safeParse({ ...base, subject: "a\tb" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toMatch(/control characters/);
  });

  it("trims the subject so a whitespace-only one is refused", () => {
    expect(
      CreateCampaignInput.safeParse({ ...base, subject: "   " }).success,
    ).toBe(false);
  });

  it("caps the block count", () => {
    const blocks = Array.from({ length: MAX_BLOCKS + 1 }, () => ({
      kind: "divider" as const,
    }));
    expect(CreateCampaignInput.safeParse({ ...base, blocks }).success).toBe(
      false,
    );
  });

  it("refuses an empty block list, because a campaign with no body is a mistake", () => {
    expect(CreateCampaignInput.safeParse({ ...base, blocks: [] }).success).toBe(
      false,
    );
  });

  it("refuses a from-address the send path would refuse", () => {
    for (const from of ["not an address", "a@b\nc@d", "<hello@acme.com"])
      expect(
        CreateCampaignInput.safeParse({ ...base, from }).success,
        from,
      ).toBe(false);
  });

  it("makes every field optional on update but keeps the same checks", () => {
    expect(UpdateCampaignInput.safeParse({}).success).toBe(true);
    expect(UpdateCampaignInput.safeParse({ subject: "a\nb" }).success).toBe(
      false,
    );
    expect(
      UpdateCampaignInput.safeParse({
        blocks: [{ kind: "button", label: "x", url: "javascript:alert(1)" }],
      }).success,
    ).toBe(false);
    expect(UpdateCampaignInput.safeParse({ replyTo: null }).success).toBe(true);
  });
});

describe("OpenAPI representability", () => {
  it("emits every exported schema as JSON Schema", () => {
    const schemas = (Object.entries(campaigns) as [string, unknown][]).filter(
      (e): e is [string, z.ZodType] => e[1] instanceof z.ZodType,
    );
    expect(schemas.length).toBeGreaterThan(5);
    for (const [name, schema] of schemas)
      expect(() => z.toJSONSchema(schema), name).not.toThrow();
  });
});
