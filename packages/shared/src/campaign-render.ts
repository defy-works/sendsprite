import {
  CampaignBlock,
  COLUMN_COUNT,
  type ColumnLayout,
  type ColumnsBlock,
  type CornerStyle,
  type LeafBlock,
} from "./api/campaigns";
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
/** The page behind the 600px card. Named because three places now emit it. */
const PAGE_BG = "#f3f4f6";

const HEADING_SIZE: Record<1 | 2 | 3, string> = {
  1: "28px",
  2: "22px",
  3: "18px",
};

const RADIUS: Record<CornerStyle, string> = {
  sharp: "0",
  soft: "6px",
  pill: "999px",
};

/** The card is 600px wide with 24px of padding on each side. */
const CONTENT_WIDTH = 552;
/** Gutter between columns, as a fixed pixel spacer cell. */
const GUTTER = 16;

/**
 * Column widths in pixels, per preset.
 *
 * Pixels, not percentages. Outlook on Windows resolves a percentage width
 * against a containing block it computes differently from every other client,
 * and a two-column row that is 50/50 everywhere and 60/40 in Outlook is the
 * classic version of this bug. The gutters are subtracted first so the widths
 * plus the gutters always total {@link CONTENT_WIDTH} exactly — a row that
 * totals one pixel more is a row Outlook wraps.
 */
function columnWidths(layout: ColumnLayout): number[] {
  const gaps = COLUMN_COUNT[layout] - 1;
  const usable = CONTENT_WIDTH - gaps * GUTTER;
  switch (layout) {
    case "1-1": {
      const half = Math.floor(usable / 2);
      return [half, usable - half];
    }
    case "1-1-1": {
      const third = Math.floor(usable / 3);
      return [third, third, usable - third * 2];
    }
    case "2-1": {
      const wide = Math.round((usable * 2) / 3);
      return [wide, usable - wide];
    }
    case "1-2": {
      const narrow = Math.round(usable / 3);
      return [narrow, usable - narrow];
    }
  }
}

/**
 * Stacks columns on a narrow viewport.
 *
 * A `<style>` element in the head, which Gmail, Apple Mail, iOS Mail and
 * Outlook.com all honour, and Outlook on Windows ignores — leaving the columns
 * side by side there, which is the right degradation: a two-column row at
 * desktop width is legible, and the alternative (no media query at all) is a
 * 552px table squeezed into a 320px phone.
 *
 * `!important` throughout because the inline `width` on each cell is what
 * every other client is reading, and an inline style beats a stylesheet
 * without it.
 */
const RESPONSIVE_CSS =
  "@media only screen and (max-width:620px){" +
  ".ss-col{display:block!important;width:100%!important;max-width:100%!important}" +
  ".ss-gutter{display:none!important;width:0!important}" +
  ".ss-card{width:100%!important}" +
  "}";

/** One full-width row wrapping a block's own markup. */
function row(inner: string): string {
  return `<tr><td style="padding:0 24px">${inner}</td></tr>`;
}

/**
 * A leaf block's markup, without the row that positions it.
 *
 * Split out from {@link renderBlock} because the same six kinds have to render
 * in two places now — directly in the card, and inside a column cell — and the
 * only difference is the wrapper. `width` is the usable width of whatever
 * contains it, which is what lets an image inside a narrow column be sized
 * against that column rather than against the card.
 */
function renderLeaf(b: LeafBlock, width: number): string {
  switch (b.kind) {
    case "heading":
      return `<h${b.level} style="${FONT};font-size:${HEADING_SIZE[b.level]};line-height:1.3;color:${b.color ?? INK};margin:24px 0 8px;text-align:${b.align ?? "left"}">${escapeHtml(b.text)}</h${b.level}>`;
    case "text":
      // Not escaped: `InlineHtml` in the contract restricts this to
      // <strong>, <em>, <br> and http(s)/mailto anchors, and requires them
      // well nested. Escaping here would render those marks as visible tags.
      // The value reaching this line has been re-checked against that schema
      // by `renderBlocks` — see the file comment for why that is not
      // redundant.
      return `<p style="${FONT};font-size:16px;line-height:1.6;color:${b.color ?? INK};margin:0 0 16px;text-align:${b.align ?? "left"}">${b.html}</p>`;
    case "button": {
      // A table around the anchor: Outlook ignores padding on inline elements,
      // so the cell has to provide the hit area. The outer table is aligned
      // rather than the inner cell, because `text-align` on a cell does not
      // move a table that is `width:auto`.
      const radius = RADIUS[b.corners ?? "soft"];
      const bg = b.color ?? ACCENT;
      const fg = b.textColor ?? "#ffffff";
      const align = b.align ?? "left";
      const table = b.fullWidth
        ? `width="100%" style="width:100%;margin:8px 0 24px"`
        : `style="margin:8px 0 24px"`;
      const margin =
        !b.fullWidth && align === "center"
          ? `margin:8px auto 24px`
          : !b.fullWidth && align === "right"
            ? `margin:8px 0 24px auto`
            : null;
      const attrs = margin
        ? `align="${align}" style="${margin}"`
        : `align="${align}" ${table}`;
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ${attrs}><tr><td align="center" style="background:${bg};border-radius:${radius}"><a href="${escapeHtml(b.url)}" style="${FONT};display:inline-block;padding:12px 24px;font-size:16px;color:${fg};text-decoration:none;border-radius:${radius}">${escapeHtml(b.label)}</a></td></tr></table>`;
    }
    case "image": {
      const pct = b.width ?? 100;
      const px = Math.round((width * pct) / 100);
      const radius = b.corners ? `;border-radius:${RADIUS[b.corners]}` : "";
      // `width` as an attribute *and* in the style: Outlook reads the
      // attribute and ignores `max-width`, every other client does the
      // reverse, and a bare percentage in one of the two is how an image ends
      // up full-bleed in exactly one client.
      const img = `<img src="${escapeHtml(b.url)}" alt="${escapeHtml(b.alt)}" width="${px}" style="display:block;width:100%;max-width:${px}px;height:auto;border:0${radius}" />`;
      const inner = b.href
        ? `<a href="${escapeHtml(b.href)}" style="text-decoration:none">${img}</a>`
        : img;
      const align = b.align ?? "left";
      if (align === "left" && pct === 100) return inner;
      const margin =
        align === "center"
          ? "margin:0 auto"
          : align === "right"
            ? "margin:0 0 0 auto"
            : "margin:0";
      return `<div style="${margin};width:${px}px;max-width:100%">${inner}</div>`;
    }
    case "divider":
      return `<hr style="border:0;border-top:1px solid ${b.color ?? "#e5e7eb"};margin:24px 0" />`;
    case "spacer":
      return `<div style="height:${b.size}px;line-height:${b.size}px;font-size:0">&nbsp;</div>`;
  }
}

/**
 * A row of columns, as a table whose cells carry fixed pixel widths.
 *
 * The gutters are their own cells rather than padding, because padding on a
 * `<td>` is one of the few box properties Outlook does honour — which means it
 * would be *added* to the width, and the row would overflow the card by
 * exactly the padding. A spacer cell cannot do that.
 */
function renderColumns(b: ColumnsBlock): string {
  const widths = columnWidths(b.layout);
  const cells = b.columns
    .map((column, i) => {
      const width = widths[i] ?? 0;
      const inner =
        column.length === 0
          ? "&nbsp;"
          : column.map((leaf) => renderLeaf(leaf, width)).join("");
      return `<td class="ss-col" width="${width}" valign="top" style="width:${width}px;vertical-align:top">${inner}</td>`;
    })
    .join(
      `<td class="ss-gutter" width="${GUTTER}" style="width:${GUTTER}px;font-size:0;line-height:0">&nbsp;</td>`,
    );
  const bg = b.background ? `background:${b.background};` : "";
  return (
    `<tr><td style="padding:0 24px;${bg}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%">` +
    `<tr>${cells}</tr></table></td></tr>`
  );
}

function renderBlock(b: CampaignBlock): string {
  if (b.kind === "columns") return renderColumns(b);
  return row(renderLeaf(b, CONTENT_WIDTH));
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
  if (b.kind === "columns")
    // Columns are a visual arrangement; a text part has no columns. Reading
    // order is the only ordering a plain-text reader has, so each column is
    // emitted in full, in order, exactly as a screen reader would encounter it.
    return b.columns
      .map((column) => column.map(blockToText).filter(Boolean).join("\n\n"))
      .filter(Boolean)
      .join("\n\n");
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
  // `background` on `<html>` as well as `<body>`, and `color-scheme: light`.
  //
  // Both are about the same failure: a document shorter than its viewport
  // paints the *root* element's background over the rest of the canvas, and
  // `<html>` had none. In the dashboard preview that meant the area below the
  // email was painted by the browser's default canvas — and because the
  // surrounding page sets `color-scheme: dark`, which inherits into a `srcdoc`
  // iframe, that default is near-black. The result was a light email sitting
  // on a dark slab, in a preview whose whole job is to show what the email
  // looks like.
  //
  // It is not only a preview problem. Gmail and Apple Mail both render in the
  // reader's dark mode, and an unpainted root is what lets a client decide the
  // background for you; naming `color-scheme: light` here says this document
  // has its own palette and should not be re-coloured.
  const html =
    `<!doctype html><html style="background:${PAGE_BG};color-scheme:light"><head><meta charset="utf-8" />` +
    `<meta name="color-scheme" content="light" />` +
    `<meta name="supported-color-schemes" content="light" />` +
    `<meta name="viewport" content="width=device-width,initial-scale=1" />` +
    `<style>${RESPONSIVE_CSS}</style></head>` +
    `<body style="margin:0;padding:0;background:${PAGE_BG};min-height:100%">` +
    `<table role="presentation" width="100%" height="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG};height:100%">` +
    `<tr><td align="center" valign="top" style="padding:24px 12px">` +
    `<table role="presentation" class="ss-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px">` +
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
