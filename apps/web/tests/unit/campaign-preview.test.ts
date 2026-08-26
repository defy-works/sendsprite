import { describe, expect, it } from "vitest";
import {
  CampaignBlock,
  MAX_BLOCK_TEXT_CHARS,
  UNSUBSCRIBE_MARKER,
  renderBlocks,
} from "@sendsprite/shared";
import { previewCampaign } from "@/app/app/campaigns/preview";
import { BLOCK_KINDS, blockDefaults, blockIssue } from "@/lib/editor/blocks";
import {
  serializeInline,
  type InlineDocNode,
} from "@/lib/editor/inline";

/** A ProseMirror document with one paragraph of the given inline nodes. */
const doc = (...content: InlineDocNode[]): InlineDocNode => ({
  type: "doc",
  content: [{ type: "paragraph", content }],
});

type Mark = NonNullable<InlineDocNode["marks"]>[number];

const text = (value: string, ...marks: Mark[]): InlineDocNode => ({
  type: "text",
  text: value,
  marks,
});

const link = (href: string): Mark => ({ type: "link", attrs: { href } });

/** The one property the whole editor is built around. */
const accepted = (html: string) =>
  CampaignBlock.safeParse({ kind: "text", html }).success;

describe("serializeInline", () => {
  it("emits the allowed marks, and the contract accepts the result", () => {
    const html = serializeInline(
      doc(
        text("Hello "),
        text("bold", { type: "bold" }),
        text(" and "),
        text("italic", { type: "italic" }),
        { type: "hardBreak" },
        text("a link", link("https://example.test/a?b=1")),
        text(" and "),
        text("mail us", link("mailto:hi@example.test")),
      ),
    );
    expect(html).toBe(
      "Hello <strong>bold</strong> and <em>italic</em><br />" +
        '<a href="https://example.test/a?b=1">a link</a> and ' +
        '<a href="mailto:hi@example.test">mail us</a>',
    );
    expect(accepted(html)).toBe(true);
  });

  it("nests link outside bold outside italic, so nothing crosses", () => {
    const html = serializeInline(
      doc(
        text("x", { type: "bold" }, { type: "italic" }, link("https://x.test")),
      ),
    );
    expect(html).toBe(
      '<a href="https://x.test"><strong><em>x</em></strong></a>',
    );
    expect(accepted(html)).toBe(true);
  });

  it("escapes text, so typed markup stays text", () => {
    const html = serializeInline(doc(text('<script>alert("x")</script> & =')));
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(accepted(html)).toBe(true);
  });

  it("drops a link whose target the contract refuses, keeping the words", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      'https://x.test/" onmouseover="alert(1)',
      "https://user:pw@evil.test/",
      "//example.test/protocol-relative",
      "",
    ]) {
      const html = serializeInline(doc(text("click me", link(href))));
      expect(html, href).toBe("click me");
      expect(accepted(html), href).toBe(true);
    }
  });

  it("keeps only the first link mark it can accept", () => {
    const html = serializeInline(
      doc(text("x", link("javascript:alert(1)"), link("https://ok.test"))),
    );
    expect(html).toBe('<a href="https://ok.test">x</a>');
  });

  it("gives an unrecognised node its text and no markup", () => {
    // Exactly the regression the allow-list serialiser exists for: a Tiptap
    // upgrade that adds a node type must widen nothing.
    const html = serializeInline({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Not a heading here" }],
        },
        {
          type: "codeBlock",
          content: [
            { type: "text", text: "rm -rf /", marks: [{ type: "code" }] },
          ],
        },
        {
          type: "image",
          attrs: { src: "https://evil.test/x.png", onerror: "alert(1)" },
        },
      ],
    });
    expect(html).toBe("Not a heading here<br />rm -rf /");
    expect(accepted(html)).toBe(true);
  });

  it("ignores a mark it does not know", () => {
    const html = serializeInline(
      doc(text("x", { type: "strike" }, { type: "underline" })),
    );
    expect(html).toBe("x");
  });

  it("strips control characters rather than emitting an invalid block", () => {
    const html = serializeInline(doc(text(`a${UNSUBSCRIBE_MARKER}b`)));
    expect(html).toBe("aSENDSPRITE_UNSUBSCRIBEb");
    expect(accepted(html)).toBe(true);
  });

  it("joins paragraphs with a break and trims the empty outer ones", () => {
    const html = serializeInline({
      type: "doc",
      content: [
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "one" }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "two" }] },
        { type: "paragraph" },
      ],
    });
    expect(html).toBe("one<br /><br />two");
  });

  it("falls back to escaped plain text when the emitted html is too long", () => {
    const long = "a".repeat(MAX_BLOCK_TEXT_CHARS + 500);
    const html = serializeInline(doc(text(long, { type: "bold" })));
    expect(html).not.toContain("<strong>");
    expect(html.length).toBe(MAX_BLOCK_TEXT_CHARS);
    expect(accepted(html)).toBe(true);
  });

  it("returns an empty, accepted string for an empty document", () => {
    expect(serializeInline({ type: "doc" })).toBe("");
    expect(accepted("")).toBe(true);
  });

  it("survives a whole round trip through the renderer", () => {
    const html = serializeInline(
      doc(text("Hi "), text("there", { type: "bold" }, link("https://x.test"))),
    );
    const rendered = renderBlocks([{ kind: "text", html }]);
    expect(rendered.html).toContain(html);
    expect(rendered.text).toContain("Hi there (https://x.test)");
  });
});

describe("blockDefaults", () => {
  it("gives every kind a body the contract already accepts", () => {
    for (const kind of BLOCK_KINDS) {
      const block = blockDefaults(kind);
      expect(block.kind, kind).toBe(kind);
      expect(blockIssue(block), kind).toBeNull();
    }
  });

  it("names the field when a block stops being valid", () => {
    expect(blockIssue({ kind: "button", label: "Go", url: "" })).toBe(
      "A URL is required.",
    );
    expect(blockIssue({ kind: "spacer", size: 2 })).not.toBeNull();
  });
});

describe("previewCampaign", () => {
  it("renders through renderBlocks and substitutes the unsubscribe marker", () => {
    const result = previewCampaign([
      { kind: "heading", level: 1, text: "Sale & more" },
      { kind: "text", html: "Hello <strong>world</strong>" },
      { kind: "button", label: "Shop", url: "https://shop.test" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The same output the send produces, minus the per-recipient link.
    const sent = renderBlocks([
      { kind: "heading", level: 1, text: "Sale & more" },
      { kind: "text", html: "Hello <strong>world</strong>" },
      { kind: "button", label: "Shop", url: "https://shop.test" },
    ]);
    expect(result.html).toBe(
      sent.html.replaceAll(
        UNSUBSCRIBE_MARKER,
        () => "Unsubscribe (a link unique to each recipient)",
      ),
    );
    expect(result.html).not.toContain(UNSUBSCRIBE_MARKER);
    expect(result.text).not.toContain(UNSUBSCRIBE_MARKER);
    expect(result.html).toContain("Sale &amp; more");
    expect(result.html).toContain('href="https://shop.test"');
  });

  it("reports the offending block instead of throwing on a stored body the contract now refuses", () => {
    // What a campaign written against an older contract looks like today.
    const stored = [
      { kind: "heading", level: 2, text: "ok" },
      { kind: "text", html: '<img src=x onerror="alert(1)">' },
    ] as unknown as CampaignBlock[];
    const result = previewCampaign(stored);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.index).toBe(1);
    expect(result.error).toContain("Block 2");
    expect(result.error).toContain("Reopen it in the editor");
  });

  it("renders an empty campaign, because the editor opens on one", () => {
    const result = previewCampaign([]);
    expect(result.ok).toBe(true);
  });
});
