import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  InvalidCampaignBlockError,
  renderBlocks,
  UNSUBSCRIBE_MARKER,
} from "../src/campaign-render";
import { CampaignBlock } from "../src/api/campaigns";
import { escapeHtml, NO_CONTROL_CHARS } from "../src/template";

const render = (blocks: CampaignBlock[]) => renderBlocks(blocks);

/**
 * Blocks the *contract* would refuse, cast past the compiler on purpose: the
 * send path reads its blocks from a `jsonb` column, and a row written by an
 * older contract, a migration or a hand-edit arrives typed but unchecked.
 * `CampaignBlock[]` is a claim about that value, not a guarantee of it.
 */
const untrusted = (b: unknown) => [b] as CampaignBlock[];

/** The renderer's own source, for the properties only the source can prove. */
const SOURCE = readFileSync(
  new URL("../src/campaign-render.ts", import.meta.url),
  "utf8",
);

describe("renderBlocks", () => {
  it("escapes heading text rather than trusting it", () => {
    const { html } = render([
      { kind: "heading", level: 1, text: '<img src=x onerror="alert(1)">' },
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("emits table-based markup, not flexbox", () => {
    const { html } = render([{ kind: "text", html: "Hello" }]);
    expect(html).toContain("<table");
    expect(html).not.toMatch(/display:\s*flex/);
  });

  it("renders a button as a table cell with an anchor, not a <button>", () => {
    const { html } = render([
      { kind: "button", label: "Read more", url: "https://example.com/a" },
    ]);
    expect(html).toContain('href="https://example.com/a"');
    expect(html).not.toContain("<button");
  });

  it("produces a text alternative that keeps link targets", () => {
    const { text } = render([
      { kind: "text", html: 'See <a href="https://example.com/x">this</a>' },
      { kind: "button", label: "Read more", url: "https://example.com/a" },
    ]);
    expect(text).toContain("this (https://example.com/x)");
    expect(text).toContain("Read more (https://example.com/a)");
  });

  it("keeps the inline marks the editor can emit", () => {
    const { html } = render([{ kind: "text", html: "a <strong>b</strong> c" }]);
    expect(html).toContain("<strong>b</strong>");
  });

  it("gives every image an alt attribute", () => {
    const { html } = render([
      { kind: "image", url: "https://example.com/a.png", alt: "A cat" },
    ]);
    expect(html).toMatch(/<img[^>]+alt="A cat"/);
  });

  it("leaves exactly one unsubscribe marker in each part", () => {
    const { html, text } = render([{ kind: "text", html: "Hi" }]);
    expect(html.split(UNSUBSCRIBE_MARKER)).toHaveLength(2);
    expect(text.split(UNSUBSCRIBE_MARKER)).toHaveLength(2);
  });

  it("is deterministic — the same blocks render byte-identically", () => {
    const blocks: CampaignBlock[] = [
      { kind: "heading", level: 2, text: "Hi" },
      { kind: "divider" },
    ];
    expect(render(blocks).html).toBe(render(blocks).html);
  });

  it("renders every block kind", () => {
    const { html, text } = render([
      { kind: "heading", level: 1, text: "One" },
      { kind: "heading", level: 2, text: "Two" },
      { kind: "heading", level: 3, text: "Three" },
      { kind: "text", html: "Body" },
      { kind: "button", label: "Go", url: "https://example.com" },
      { kind: "image", url: "https://example.com/a.png", alt: "Alt" },
      {
        kind: "image",
        url: "https://e.test/b.png",
        alt: "B",
        href: "https://e.test",
      },
      { kind: "divider" },
      { kind: "spacer", size: 24 },
    ]);
    expect(html).toContain("<h1");
    expect(html).toContain("<h2");
    expect(html).toContain("<h3");
    expect(html).toContain('<a href="https://e.test"');
    expect(text).toContain("One");
    expect(text).toContain("[Alt]");
    expect(text).toContain("---");
  });

  it("renders an empty body — an untouched editor is not an error", () => {
    // `min(1)` is the API contract's rule about a *sendable* campaign, not the
    // renderer's rule about a *renderable* one; the preview opens empty.
    const { html, text } = render([]);
    expect(html).toContain(UNSUBSCRIBE_MARKER);
    expect(text).toBe(UNSUBSCRIBE_MARKER);
  });

  it("does not mutate the blocks it is given", () => {
    const blocks: CampaignBlock[] = [
      { kind: "button", label: "Go", url: "https://example.com" },
    ];
    const before = JSON.stringify(blocks);
    render(blocks);
    expect(JSON.stringify(blocks)).toBe(before);
  });
});

/**
 * The renderer re-validates, and these cases are why. Each one is a value the
 * contract refuses, and each one reaches an unescaped or un-escapable position
 * in the output if the renderer takes its parameter type at face value.
 */
describe("untrusted blocks at the jsonb boundary", () => {
  it("refuses a script tag in a text block rather than emitting it", () => {
    const bad = untrusted({ kind: "text", html: "<script>alert(1)</script>" });
    expect(() => renderBlocks(bad)).toThrow(InvalidCampaignBlockError);
    // Not "escaped instead": nothing is emitted at all.
    expect(() => renderBlocks(bad)).toThrow(/block 0/i);
  });

  it("refuses an event handler smuggled past the href quote", () => {
    expect(() =>
      renderBlocks(
        untrusted({
          kind: "text",
          html: '<a href="https://x.test" onclick="alert(1)">x</a>',
        }),
      ),
    ).toThrow(InvalidCampaignBlockError);
  });

  it("refuses an entity-encoded quote inside an href", () => {
    expect(() =>
      renderBlocks(
        untrusted({
          kind: "text",
          html: '<a href="https://x.test/&#x22; onmouseover=&#x22;alert(1)">x</a>',
        }),
      ),
    ).toThrow(InvalidCampaignBlockError);
  });

  it("refuses an unclosed anchor, which would swallow the footer", () => {
    expect(() =>
      renderBlocks(
        untrusted({ kind: "text", html: '<a href="https://x.test">open' }),
      ),
    ).toThrow(InvalidCampaignBlockError);
  });

  it("refuses a javascript: button URL, which escaping cannot make safe", () => {
    expect(() =>
      renderBlocks(
        untrusted({ kind: "button", label: "Go", url: "javascript:alert(1)" }),
      ),
    ).toThrow(InvalidCampaignBlockError);
  });

  it("refuses a button URL that closes its own attribute", () => {
    expect(() =>
      renderBlocks(
        untrusted({
          kind: "button",
          label: "Go",
          url: 'https://x.test/" onmouseover="alert(1)',
        }),
      ),
    ).toThrow(InvalidCampaignBlockError);
  });

  it("refuses a data: image URL", () => {
    expect(() =>
      renderBlocks(
        untrusted({
          kind: "image",
          url: "data:text/html;base64,PHNjcmlwdD4=",
          alt: "x",
        }),
      ),
    ).toThrow(InvalidCampaignBlockError);
  });

  it("refuses a URL carrying credentials", () => {
    expect(() =>
      renderBlocks(
        untrusted({
          kind: "button",
          label: "Go",
          url: "https://example.com@evil.test/login",
        }),
      ),
    ).toThrow(InvalidCampaignBlockError);
  });

  it("refuses an unknown block kind rather than silently dropping it", () => {
    expect(() => renderBlocks(untrusted({ kind: "video", url: "x" }))).toThrow(
      InvalidCampaignBlockError,
    );
  });

  it("refuses a body that is not an array at all", () => {
    expect(() => renderBlocks(null as unknown as CampaignBlock[])).toThrow(
      InvalidCampaignBlockError,
    );
    expect(() => renderBlocks({} as unknown as CampaignBlock[])).toThrow(
      InvalidCampaignBlockError,
    );
  });

  it("names the offending index and keeps the cause", () => {
    try {
      renderBlocks([
        { kind: "divider" },
        { kind: "text", html: "<script>x</script>" },
      ] as CampaignBlock[]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidCampaignBlockError);
      expect((e as InvalidCampaignBlockError).index).toBe(1);
      expect((e as InvalidCampaignBlockError).cause).toBeDefined();
    }
  });

  it("renders the parsed value, so what is rendered is what would be stored", () => {
    const { html } = renderBlocks(
      untrusted({ kind: "button", label: "Go", url: "  https://e.test/a  " }),
    );
    expect(html).toContain('href="https://e.test/a"');
  });

  it("drops properties the contract does not know about", () => {
    const { html } = renderBlocks(
      untrusted({ kind: "divider", onclick: "javascript:1" }),
    );
    expect(html).not.toContain("javascript");
  });

  it("refuses a known property carrying an unknown value", () => {
    // Stripping is for keys the contract has never heard of. A key it *does*
    // know, holding something outside its enum, is a body that disagrees with
    // the contract — and rendering it minus the field would quietly send
    // something other than what is stored.
    expect(() =>
      renderBlocks(
        untrusted({
          kind: "divider",
          lineStyle: "url(javascript:1)",
        }),
      ),
    ).toThrow(InvalidCampaignBlockError);
  });
});

/**
 * The marker is substituted per recipient by the fan-out. Two failure modes
 * matter: a customer adding a second one, and a customer displacing the real
 * one. Both are closed by choosing a marker no block field can contain.
 */
describe("the unsubscribe marker", () => {
  it("cannot appear in any block field the contract admits", () => {
    // Every text-bearing field in the union — heading text, inline HTML,
    // button label, image alt, and every URL — is guarded by
    // `NO_CONTROL_CHARS`. A marker built from a control character is therefore
    // unrepresentable in all of them at once, with no per-field reasoning.
    expect(NO_CONTROL_CHARS.test(UNSUBSCRIBE_MARKER)).toBe(false);
  });

  it("is refused wherever a customer could try to author it", () => {
    const attempts: unknown[] = [
      { kind: "heading", level: 1, text: UNSUBSCRIBE_MARKER },
      { kind: "text", html: UNSUBSCRIBE_MARKER },
      { kind: "button", label: UNSUBSCRIBE_MARKER, url: "https://e.test" },
      { kind: "image", url: "https://e.test/a.png", alt: UNSUBSCRIBE_MARKER },
    ];
    for (const b of attempts) {
      expect(CampaignBlock.safeParse(b).success, JSON.stringify(b)).toBe(false);
      expect(() => renderBlocks(untrusted(b))).toThrow(
        InvalidCampaignBlockError,
      );
    }
  });

  it("survives escaping unchanged, so the fan-out can still find it", () => {
    expect(escapeHtml(UNSUBSCRIBE_MARKER)).toBe(UNSUBSCRIBE_MARKER);
  });

  it("cannot be displaced: it is appended, never authored", () => {
    const { html, text } = render([
      { kind: "heading", level: 1, text: "unsubscribe" },
      { kind: "text", html: 'Click <a href="https://e.test">unsubscribe</a>' },
    ]);
    expect(html.split(UNSUBSCRIBE_MARKER)).toHaveLength(2);
    expect(text.split(UNSUBSCRIBE_MARKER)).toHaveLength(2);
  });
});

describe("the plain-text alternative", () => {
  /** Every construct `INLINE_HTML_RE` admits, in one string. */
  const EVERY_MARK =
    "Plain &amp; text <strong>bold</strong> <em>it</em>" +
    "<br /><br><br/><br >" +
    '<a href="https://example.com/a?b=1&amp;c=2">link</a> ' +
    '<a href="mailto:hi@example.com">mail</a> ' +
    "<strong>bold <em>nested</em></strong>";

  it("uses only constructs the contract actually admits", () => {
    expect(
      CampaignBlock.safeParse({ kind: "text", html: EVERY_MARK }).success,
    ).toBe(true);
  });

  it("leaks no markup for any construct the contract admits", () => {
    const { text } = render([{ kind: "text", html: EVERY_MARK }]);
    expect(text).not.toMatch(/[<>]/);
    expect(text).not.toMatch(/&[a-z]+;/);
    expect(text).toContain("link (https://example.com/a?b=1&c=2)");
    expect(text).toContain("mail (mailto:hi@example.com)");
    expect(text).toContain("Plain & text bold it");
    expect(text).toContain("bold nested");
  });

  it("emits the same text block verbatim into the HTML part", () => {
    const { html } = render([{ kind: "text", html: EVERY_MARK }]);
    expect(html).toContain(EVERY_MARK);
  });

  it("turns every admitted <br> spelling into a newline", () => {
    for (const br of ["<br>", "<br/>", "<br />", "<br >"]) {
      const { text } = render([{ kind: "text", html: `a${br}b` }]);
      expect(text, br).toBe(`a\nb\n\n${UNSUBSCRIBE_MARKER}`);
    }
  });

  it("decodes exactly what escapeHtml encodes", () => {
    // The round trip is the invariant: whatever the editor escaped on the way
    // in comes back out as the character the author typed.
    const raw = "a&b<c>d\"e'f`g=h";
    const { text } = render([{ kind: "text", html: escapeHtml(raw) }]);
    expect(text.split("\n\n")[0]).toBe(raw);
  });

  it("does not double-decode an escaped entity", () => {
    const { text } = render([{ kind: "text", html: "&amp;lt;" }]);
    expect(text.split("\n\n")[0]).toBe("&lt;");
  });

  it("does not entity-decode a heading, which was never markup", () => {
    const { text } = render([{ kind: "heading", level: 1, text: "a &amp; b" }]);
    expect(text).toContain("a &amp; b");
  });

  it("keeps a link label's own marks out of the target", () => {
    const { text } = render([
      {
        kind: "text",
        html: '<a href="https://e.test/x"><strong>Buy</strong></a>',
      },
    ]);
    expect(text).toContain("Buy (https://e.test/x)");
  });
});

describe("escaping at the attribute boundary", () => {
  it("escapes every character that can break out of an attribute", () => {
    expect(escapeHtml("&<>\"'`=")).toBe("&amp;&lt;&gt;&quot;&#39;&#96;&#61;");
  });

  it("is no defence at all against a scheme — which is why we validate", () => {
    // Unchanged, and still a working href. The scheme allow-list is the only
    // thing between a stored block and a `javascript:` link in an inbox.
    expect(escapeHtml("javascript:alert(1)")).toBe("javascript:alert(1)");
  });

  it("keeps a query string working through the entity encoding", () => {
    const { html } = render([
      { kind: "button", label: "Go", url: "https://example.com/a?b=1&c=2" },
    ]);
    // `&` and `=` are entity-encoded; an HTML parser decodes both inside an
    // attribute value, so the resolved href is the URL that was stored.
    expect(html).toContain('href="https://example.com/a?b&#61;1&amp;c&#61;2"');
  });

  it("escapes an image alt containing a quote", () => {
    const { html } = render([
      { kind: "image", url: "https://e.test/a.png", alt: 'a" onerror="x' },
    ]);
    expect(html).toContain('alt="a&quot; onerror&#61;&quot;x"');
    expect(html).not.toMatch(/<img[^>]*\sonerror=/);
  });

  it("escapes a button label containing markup", () => {
    const { html } = render([
      { kind: "button", label: "<b>Go</b>", url: "https://e.test" },
    ]);
    expect(html).toContain("&lt;b&gt;Go&lt;/b&gt;");
    expect(html).not.toContain("<b>Go</b>");
  });
});

describe("determinism", () => {
  const blocks = (): CampaignBlock[] => [
    { kind: "heading", level: 1, text: "Hi & bye" },
    { kind: "text", html: "a <strong>b</strong> <em>c</em>" },
    { kind: "button", label: "Go", url: "https://example.com/a?x=1" },
    {
      kind: "image",
      url: "https://example.com/a.png",
      alt: "A",
      href: "https://e.test",
    },
    { kind: "divider" },
    { kind: "spacer", size: 32 },
  ];

  it("renders byte-identically across calls and across equal inputs", () => {
    const first = renderBlocks(blocks());
    for (let i = 0; i < 5; i++) {
      const again = renderBlocks(blocks());
      expect(again.html).toBe(first.html);
      expect(again.text).toBe(first.text);
    }
  });

  it("reads no clock and no randomness", () => {
    expect(SOURCE).not.toMatch(/\bDate\b|Math\.random|performance\.now/);
  });

  it("iterates no object's keys, whose order is not part of the contract", () => {
    expect(SOURCE).not.toMatch(/Object\.(keys|values|entries)/);
    expect(SOURCE).not.toMatch(/for\s*\([^)]*\bin\b[^)]*\)/);
  });
});
