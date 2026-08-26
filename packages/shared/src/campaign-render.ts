import { CampaignBlock } from "./api/campaigns";
import { escapeHtml } from "./template";

/**
 * Blocks → email-safe HTML and a plain-text alternative.
 *
 * Pure and deterministic: no clock, no randomness, no network, no object-key
 * iteration. The dashboard preview and the send both call this, which is what
 * stops a preview from disagreeing with what recipients receive — the seam
 * discipline Phase 6 applied to templates.
 *
 * ## Why tables and inline styles
 *
 * Outlook on Windows renders with Word's HTML engine: no flexbox, no grid, no
 * dependable `<style>` support, and most external CSS ignored. Table cells
 * with inline `style` attributes are the only layout that behaves the same in
 * Gmail, Outlook, Apple Mail and the long tail. This is the current
 * compatibility floor, not nostalgia.
 *
 * ## This renderer does not trust its parameter type
 *
 * `renderBlocks` re-validates every block against `CampaignBlock` and throws
 * `InvalidCampaignBlockError` rather than rendering one it cannot vouch for.
 * The parameter is typed for the benefit of typed call sites; the runtime
 * check is what actually holds, for three reasons:
 *
 * 1. **The send path's blocks come out of a `jsonb` column.** `CampaignBlock[]`
 *    there is a claim a migration, a hand-edit or an older version of the
 *    contract can falsify, and TypeScript will never notice.
 * 2. **One field is emitted unescaped.** `text.html` goes into the document as
 *    markup on the strength of `INLINE_HTML_RE` and `isWellNested` alone, and
 *    a URL inside an `href` is un-escapable by construction —
 *    `escapeHtml("javascript:alert(1)")` is still a working link. If those
 *    checks live only at the API boundary, the safety property is non-local:
 *    the next call site added (an admin tool, a fixture, a re-render of an
 *    archived campaign) breaks it silently. Checking here makes the property
 *    local to the code that relies on it.
 * 3. **It is what makes {@link UNSUBSCRIBE_MARKER} uncollidable.** The marker
 *    is safe from customer text only because no block field may contain a
 *    control character — which is a fact about validated blocks, not about
 *    `jsonb`.
 *
 * Throwing rather than degrading is deliberate: a body that no longer
 * validates is a data-integrity bug, and mailing a visibly broken email to a
 * whole contact book is worse than refusing to send it. Both call sites should
 * surface the refusal ("this campaign body is no longer valid — reopen it in
 * the editor") rather than swallow it.
 *
 * The cost is one parse of at most `MAX_BLOCKS` blocks per campaign, not per
 * recipient: the fan-out renders once and substitutes the marker per row.
 */

/**
 * A stored block that is not a valid `CampaignBlock`.
 *
 * Carries the index so a caller can say *which* block, and the Zod error as
 * `cause` so a caller can say why, without either having to re-parse.
 */
export class InvalidCampaignBlockError extends Error {
  readonly index: number;

  constructor(index: number, cause: unknown) {
    super(
      `Campaign block ${index} is not a valid block. The stored campaign body ` +
        `does not match the current contract and was not rendered.`,
      { cause },
    );
    this.name = "InvalidCampaignBlockError";
    this.index = index;
  }
}

/**
 * Substituted per recipient by the fan-out (Task 7), because every recipient
 * needs a different unsubscribe link and this renderer is pure.
 *
 * ## Why a control character rather than a readable sentinel
 *
 * The fan-out substitutes this with a plain global string replace, so a marker
 * a customer can author is a marker a customer can *forge*: type it into a
 * heading and the mail goes out with two unsubscribe links, one of them in the
 * middle of a sentence. (Displacing the real one is not possible either way —
 * it is appended by this file, not authored — but a second one is bad enough.)
 *
 * A U+0001 delimiter closes that off completely rather than
 * probabilistically. Every text-bearing field of every block kind —
 * heading text, inline HTML, button label, image alt, and every URL — is
 * guarded by `NO_CONTROL_CHARS`, so a marker containing one is
 * unrepresentable in *all* of them at once, and stays so if a block kind is
 * added later. A readable sentinel would need a per-field argument about how
 * unlikely it is, which is not the same thing.
 *
 * Written as an escape rather than a literal control character: an invisible
 * byte in a source file is one careless re-encode away from being something
 * else, and the marker would then silently stop matching.
 *
 * `escapeHtml` does not touch it, so it survives into both parts intact.
 */
export const UNSUBSCRIBE_MARKER = "\u0001SENDSPRITE_UNSUBSCRIBE\u0001";

const FONT =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const INK = "#111111";
const MUTED = "#6b7280";
const ACCENT = "#4f46e5";

const HEADING_SIZE: Record<1 | 2 | 3, string> = {
  1: "28px",
  2: "22px",
  3: "18px",
};

/** One full-width row wrapping a block's own markup. */
function row(inner: string): string {
  return `<tr><td style="padding:0 24px">${inner}</td></tr>`;
}

function renderBlock(b: CampaignBlock): string {
  switch (b.kind) {
    case "heading":
      return row(
        `<h${b.level} style="${FONT};font-size:${HEADING_SIZE[b.level]};line-height:1.3;color:${INK};margin:24px 0 8px">${escapeHtml(b.text)}</h${b.level}>`,
      );
    case "text":
      // Not escaped: `InlineHtml` in the contract restricts this to
      // <strong>, <em>, <br> and http(s)/mailto anchors, and requires them
      // well nested. Escaping here would render those marks as visible tags.
      // The value reaching this line has been re-checked against that schema
      // by `renderBlocks` — see the file comment for why that is not
      // redundant.
      return row(
        `<p style="${FONT};font-size:16px;line-height:1.6;color:${INK};margin:0 0 16px">${b.html}</p>`,
      );
    case "button":
      // A table around the anchor: Outlook ignores padding on inline elements,
      // so the cell has to provide the hit area.
      return row(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr><td style="background:${ACCENT};border-radius:6px"><a href="${escapeHtml(b.url)}" style="${FONT};display:inline-block;padding:12px 24px;font-size:16px;color:#ffffff;text-decoration:none">${escapeHtml(b.label)}</a></td></tr></table>`,
      );
    case "image": {
      const img = `<img src="${escapeHtml(b.url)}" alt="${escapeHtml(b.alt)}" style="display:block;width:100%;max-width:552px;height:auto;border:0" />`;
      return row(
        b.href
          ? `<a href="${escapeHtml(b.href)}" style="text-decoration:none">${img}</a>`
          : img,
      );
    }
    case "divider":
      return row(
        `<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0" />`,
      );
    case "spacer":
      return row(
        `<div style="height:${b.size}px;line-height:${b.size}px;font-size:0">&nbsp;</div>`,
      );
  }
}

/**
 * The inverse of `escapeHtml`, plus `&nbsp;`.
 *
 * The text alternative is not markup, so an entity that survives into it is a
 * leak: a recipient whose client shows the text part reads `a &amp; b` where
 * the HTML part says `a & b`. The editor serialises to HTML, so `&amp;`,
 * `&lt;` and `&nbsp;` are the ordinary output of typing `&`, `<` and a
 * non-breaking space — not exotic input.
 *
 * Pairing it with `escapeHtml`'s own table rather than a general entity
 * decoder is what keeps it honest: the set can only drift if `escapeHtml`
 * changes, and the round trip `decodeEntities(escapeHtml(s)) === s` is
 * asserted. `&amp;` is decoded last, so `&amp;lt;` yields `&lt;` and not `<`.
 */
const TEXT_ENTITIES: readonly (readonly [RegExp, string])[] = [
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&#96;/g, "`"],
  [/&#61;/g, "="],
  [/&nbsp;/g, "\u00a0"],
  [/&amp;/g, "&"],
];

function decodeEntities(s: string): string {
  let out = s;
  for (const [re, ch] of TEXT_ENTITIES) out = out.replace(re, ch);
  return out;
}

/**
 * Strips the allowed inline marks, keeping link targets visible.
 *
 * The three patterns are written against what `INLINE_HTML_RE` admits, not
 * against HTML in general — `<br ?\/?>` there spells the tag four ways, so
 * `\s?\/?` here has to accept all four or a literal `<br />` reaches the
 * recipient's text part. There is no anchor without a closing tag and no
 * anchor inside another (`isWellNested` refuses both), so the non-greedy
 * `[\s\S]*?` cannot mis-pair.
 */
function blockToText(b: CampaignBlock): string {
  switch (b.kind) {
    case "heading":
      // Not entity-decoded: heading text is plain text in the contract and was
      // never escaped on the way in. Decoding it would turn a literal `&amp;`
      // the author typed into an `&`.
      return b.text;
    case "text":
      return decodeEntities(
        b.html
          .replace(
            /<a href="([^"]*)">([\s\S]*?)<\/a>/g,
            (_m, href: string, label: string) => `${label} (${href})`,
          )
          .replace(/<br\s?\/?>/g, "\n")
          .replace(/<\/?(?:strong|em)>/g, ""),
      );
    case "button":
      return `${b.label} (${b.url})`;
    case "image":
      return b.alt ? `[${b.alt}]` : "";
    case "divider":
      return "---";
    case "spacer":
      return "";
  }
}

export interface RenderedCampaign {
  html: string;
  text: string;
}

/**
 * Re-parses the stored body.
 *
 * Returns the *parsed* values, not the inputs: `SafeUrl` trims, and object
 * schemas strip unknown keys, so rendering the parse output is what makes the
 * preview show exactly what a save would have stored. Also leaves the caller's
 * array untouched, which a renderer has no business modifying.
 */
function validate(blocks: readonly CampaignBlock[]): CampaignBlock[] {
  if (!Array.isArray(blocks)) throw new InvalidCampaignBlockError(0, blocks);
  return blocks.map((b, i) => {
    const parsed = CampaignBlock.safeParse(b);
    if (!parsed.success) throw new InvalidCampaignBlockError(i, parsed.error);
    return parsed.data;
  });
}

/**
 * Renders a campaign body. Throws {@link InvalidCampaignBlockError} if any
 * block fails the contract — see the file comment for why that check is here
 * and not only at the API boundary.
 *
 * An empty list renders: "at least one block" is the API contract's rule about
 * a *sendable* campaign, not this function's rule about a *renderable* one,
 * and the dashboard preview opens on an empty editor.
 */
export function renderBlocks(
  blocks: readonly CampaignBlock[],
): RenderedCampaign {
  const safe = validate(blocks);

  const body = safe.map(renderBlock).join("");
  const html =
    `<!doctype html><html><head><meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width,initial-scale=1" /></head>` +
    `<body style="margin:0;padding:0;background:#f3f4f6">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6">` +
    `<tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px">` +
    body +
    `<tr><td style="padding:8px 24px 24px">` +
    `<p style="${FONT};font-size:12px;line-height:1.5;color:${MUTED};margin:0">${UNSUBSCRIBE_MARKER}</p>` +
    `</td></tr></table></td></tr></table></body></html>`;

  const text = safe
    .map(blockToText)
    .filter((s) => s !== "")
    .join("\n\n");

  return {
    html,
    text: text === "" ? UNSUBSCRIBE_MARKER : `${text}\n\n${UNSUBSCRIBE_MARKER}`,
  };
}
