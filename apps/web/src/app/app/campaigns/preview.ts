import {
  CampaignBlock,
  InvalidCampaignBlockError,
  MAX_BLOCK_TEXT_CHARS,
  SafeUrl,
  TextBlock,
  UNSUBSCRIBE_MARKER,
  escapeHtml,
  renderBlocks,
  type ColumnLayout,
  type LeafBlock,
} from "@sendsprite/shared";

/**
 * The pure half of the campaign editor: the block list the form holds, the
 * serialisation between the rich-text editor and the contract, and the live
 * preview.
 *
 * It is a module rather than hooks inside the component for the reason
 * `templates/preview.ts` gives — a `.tsx` client component is not something
 * this repo's vitest setup can mount, and the parts worth asserting are the
 * parts that must not drift. Here that is sharper than it was for templates,
 * because one of these functions is a **security boundary**.
 *
 * ## `serializeInline` is the boundary, not the Tiptap configuration
 *
 * `TextBlock.html` is the one campaign field the renderer emits *unescaped*
 * (see `campaign-render.ts`), on the strength of `INLINE_HTML_RE` and
 * `isWellNested` alone. Decision 7 answers that by scoping the editor to
 * inline marks — but "the editor is configured not to emit a `<script>`" is a
 * property of a dependency's defaults, and a Tiptap minor that adds a node
 * type would quietly widen it.
 *
 * So the editor's HTML serialiser is not used at all. `serializeInline` walks
 * the ProseMirror JSON document and **writes** the markup itself, from an
 * allow-list of three marks and one node:
 *
 * - it emits `<strong>`, `<em>`, `<br />` and `<a href="…">` and nothing else;
 * - it never copies an attribute — the only attribute it writes is an `href`
 *   that `SafeUrl` has already accepted;
 * - a node type it does not recognise contributes its **text** and no markup,
 *   so a new Tiptap node is inert here rather than a new escape hatch;
 * - and the result is checked against `TextBlock` before it is returned, with
 *   a plain-escaped-text fallback if it somehow fails.
 *
 * That last check is what makes the property testable rather than argued:
 * `serializeInline` cannot return a string `CampaignBlock` refuses. This is an
 * allow-list serialiser, not a sanitiser — nothing passes through unless this
 * file explicitly writes it out.
 *
 * The Tiptap configuration in `blocks/InlineEditor.tsx` is still locked down,
 * because an editor that lets someone paste a heading and then silently drops
 * it is a bad editor. But it is defence in depth; this file is the guarantee.
 */

/* ------------------------------------------------------------------ *
 * Editor document → contract
 * ------------------------------------------------------------------ */

/**
 * The shape of `editor.getJSON()`, narrowed to what the serialiser reads.
 *
 * Declared structurally rather than imported from `@tiptap/core` on purpose:
 * this module has no dependency on the editor, which is what lets the unit
 * test drive it with hand-written documents — including documents Tiptap
 * cannot currently produce, which is exactly the regression worth pinning.
 */
export interface InlineDocNode {
  type?: string;
  text?: string;
  /**
   * Declared and never read. A node's attributes are where a widened schema
   * would put `src`, `class` or an event handler, and the serialiser writes
   * exactly one attribute in the whole file — an `href` `SafeUrl` accepted.
   * Leaving the field out would only mean a caller's object literal is
   * rejected while the same value in a variable is not; saying so is better.
   */
  attrs?: Record<string, unknown> | null;
  marks?: readonly {
    type?: string;
    attrs?: Record<string, unknown> | null;
  }[];
  content?: readonly InlineDocNode[];
}

/** Same class as `NO_CONTROL_CHARS` refuses, removed rather than rejected. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;

const stripControl = (s: string): string => s.replace(CONTROL_CHARS, "");

const hasMark = (node: InlineDocNode, type: string): boolean =>
  (node.marks ?? []).some((m) => m?.type === type);

/**
 * The first link mark's `href`, as `SafeUrl` parses it, or `null`.
 *
 * Parsed rather than trusted: the mark's attributes came out of a ProseMirror
 * document that a paste, a stored body or a future extension could have put
 * anything into, and this string is written into an `href` where escaping is
 * no defence at all. A link whose target is refused loses the link and keeps
 * its text — dropping the words as well would silently delete what somebody
 * wrote.
 */
function linkHref(node: InlineDocNode): string | null {
  for (const m of node.marks ?? []) {
    if (m?.type !== "link") continue;
    const raw = m.attrs?.href;
    if (typeof raw !== "string") continue;
    const parsed = SafeUrl.safeParse(raw);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * One text node with its marks, nested link → bold → italic.
 *
 * A fixed nesting order matters: `isWellNested` refuses crossed tags, and
 * emitting each text node as a self-contained run means two adjacent runs can
 * never interleave. Adjacent runs with the same marks are left unmerged —
 * `<strong>a</strong><strong>b</strong>` renders identically to
 * `<strong>ab</strong>`, and merging would be a second place for the nesting
 * rules to be got wrong.
 */
function emitText(node: InlineDocNode): string {
  const text = stripControl(node.text ?? "");
  if (text === "") return "";
  let out = escapeHtml(text);
  if (hasMark(node, "italic")) out = `<em>${out}</em>`;
  if (hasMark(node, "bold")) out = `<strong>${out}</strong>`;
  const href = linkHref(node);
  // Not escaped, and it must not be: `INLINE_HTML_RE` matches the raw URL
  // between the quotes, and `SafeUrl` has already refused every character
  // that could close the attribute.
  if (href !== null) out = `<a href="${href}">${out}</a>`;
  return out;
}

/**
 * One node's markup.
 *
 * The `default` branch is the load-bearing one: an unrecognised node — a
 * heading, a list, a code block, anything a Tiptap upgrade introduces —
 * contributes only the text of its descendants. It cannot introduce a tag,
 * because there is no code path here that writes a tag it was not asked for.
 */
function emitNode(node: InlineDocNode): string {
  if (node.type === "text") return emitText(node);
  if (node.type === "hardBreak") return "<br />";
  return (node.content ?? []).map(emitNode).join("");
}

/** Every text node's text, joined with spaces: the fallback's raw material. */
function plainText(node: InlineDocNode): string {
  if (node.type === "text") return stripControl(node.text ?? "");
  // A space, never a newline: `NO_CONTROL_CHARS` refuses `\n`, so a fallback
  // built with line breaks would be as invalid as what it is replacing.
  return (node.content ?? [])
    .map(plainText)
    .filter((s) => s !== "")
    .join(" ");
}

/**
 * Top-level blocks joined with `<br />`.
 *
 * A text block renders as a single `<p>`, so a paragraph break in the editor
 * has to become a line break in the output — there is nowhere else for it to
 * go. Interior empty paragraphs are kept (they are the blank line somebody
 * typed); leading and trailing ones are dropped, because they are what a
 * trailing cursor leaves behind rather than something anybody meant.
 */
function emitDoc(doc: InlineDocNode): string {
  const parts = (doc.content ?? []).map(emitNode);
  while (parts.length > 0 && parts[0] === "") parts.shift();
  while (parts.length > 0 && parts.at(-1) === "") parts.pop();
  return parts.join("<br />");
}

/**
 * A ProseMirror document as the inline HTML a `text` block stores.
 *
 * Guaranteed to be accepted by `TextBlock` — the final check below is what
 * makes that a fact rather than a claim about the code above it. The fallback
 * cannot itself fail: escaped text contains no `<` or `>`, control characters
 * are stripped, and the slice bounds the length.
 */
export function serializeInline(doc: InlineDocNode): string {
  const html = emitDoc(doc);
  if (TextBlock.safeParse({ kind: "text", html }).success) return html;
  return escapeHtml(plainText(doc)).slice(0, MAX_BLOCK_TEXT_CHARS);
}

/* ------------------------------------------------------------------ *
 * The block list
 * ------------------------------------------------------------------ */

export type BlockKind = CampaignBlock["kind"];
/** Everything that can sit inside a column, which is everything but a row. */
export type LeafKind = LeafBlock["kind"];

/** Insertion order of the block palette, and the only leaf kinds that exist. */
export const BLOCK_KINDS = [
  "heading",
  "text",
  "button",
  "image",
  "divider",
  "spacer",
] as const satisfies readonly LeafKind[];

export const BLOCK_LABELS: Record<BlockKind, string> = {
  heading: "Heading",
  text: "Text",
  button: "Button",
  image: "Image",
  divider: "Divider",
  spacer: "Spacer",
  columns: "Columns",
};

/** What each layout is called in the palette, and what it looks like. */
export const LAYOUT_LABELS: Record<ColumnLayout, string> = {
  "1-1": "Two columns",
  "1-1-1": "Three columns",
  "2-1": "Wide + narrow",
  "1-2": "Narrow + wide",
};

/**
 * What a freshly added block holds.
 *
 * Every default is a **valid** block, which is a deliberate choice with a
 * cost: a button carries `https://example.com` until somebody changes it. The
 * alternative — an empty required URL — makes `renderBlocks` throw for the
 * whole body the instant a button is added, so adding a block would blank the
 * preview rather than show the thing that was just added. Per-block validation
 * (`blockIssue`) reports a field left empty afterwards, and the service
 * refuses the save regardless, so the placeholder cannot reach a send silently.
 */
export function blockDefaults(kind: LeafKind): LeafBlock {
  switch (kind) {
    case "heading":
      return { kind: "heading", level: 2, text: "Your headline" };
    case "text":
      return { kind: "text", html: "Write your message here." };
    case "button":
      return { kind: "button", label: "Read more", url: "https://example.com" };
    case "image":
      return {
        kind: "image",
        url: "https://example.com/image.png",
        alt: "Describe this image",
      };
    case "divider":
      return { kind: "divider" };
    case "spacer":
      return { kind: "spacer", size: 24 };
  }
}

/**
 * One token per module instance, so the server and the browser cannot mint the
 * same id.
 *
 * The initial tree is built on the server (it comes off a stored row and
 * arrives as a prop), and every block added afterwards is minted in the
 * browser. A bare counter would have the browser's first "add block" collide
 * with the server's first block — same React key, same dnd-kit id, and a drag
 * that edits the wrong card. The counter alone is not enough and a random id
 * per block is more than is needed.
 *
 * The tree itself lives in `tree.ts`; this stays here because it is the id
 * scheme, not the structure, and `tree.ts` imports it.
 */
const ID_PREFIX = Math.random().toString(36).slice(2, 8);
let idCounter = 0;

/** Unique within one editor session, which is the whole requirement. */
export const newBlockId = (): string => `blk-${ID_PREFIX}-${++idCounter}`;

/**
 * Why one block would be refused, or `null`.
 *
 * The same `CampaignBlock` the service and the renderer parse, so a field the
 * editor flags is a field the save would have rejected — there is no second
 * set of rules for the form to disagree with.
 */
export function blockIssue(block: CampaignBlock): string | null {
  const parsed = CampaignBlock.safeParse(block);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? "This block is not valid.";
}

/* ------------------------------------------------------------------ *
 * The preview
 * ------------------------------------------------------------------ */

export type CampaignPreview =
  | { ok: true; html: string; text: string }
  | { ok: false; error: string; index: number | null };

/**
 * What stands in for the per-recipient unsubscribe link.
 *
 * `renderBlocks` leaves {@link UNSUBSCRIBE_MARKER} in both parts and the
 * fan-out swaps it for a link unique to each recipient — so a preview that
 * left the marker alone would show an invisible control character where every
 * recipient sees a footer. Substituting a stand-in is the *same* step the
 * fan-out performs, one line further from the send; it is not a second
 * renderer, and the surrounding markup is still the send's own.
 */
const PREVIEW_UNSUBSCRIBE_HTML =
  "Unsubscribe (a link unique to each recipient)";
const PREVIEW_UNSUBSCRIBE_TEXT = "Unsubscribe: a link unique to each recipient";

/**
 * The live preview, rendered by the **same** `renderBlocks` the send calls.
 *
 * There is deliberately no React renderer for blocks anywhere in this app: a
 * preview with its own renderer starts agreeing with itself and disagreeing
 * with what lands in the inbox, which is the failure Phase 6 built the
 * template preview through this seam to avoid.
 *
 * `InvalidCampaignBlockError` is caught rather than allowed to escape, because
 * the editor renders **stored** blocks: a body written against an older
 * contract throws here, and the honest answer is to say which block and tell
 * the author to fix it — not a blank panel and not a crashed route.
 */
export function previewCampaign(
  blocks: readonly CampaignBlock[],
): CampaignPreview {
  try {
    const rendered = renderBlocks(blocks);
    return {
      ok: true,
      html: rendered.html.replaceAll(
        UNSUBSCRIBE_MARKER,
        () => PREVIEW_UNSUBSCRIBE_HTML,
      ),
      text: rendered.text.replaceAll(
        UNSUBSCRIBE_MARKER,
        () => PREVIEW_UNSUBSCRIBE_TEXT,
      ),
    };
  } catch (e) {
    if (e instanceof InvalidCampaignBlockError)
      return {
        ok: false,
        index: e.index,
        error:
          `Block ${e.index + 1} of this campaign body is no longer valid, so ` +
          `nothing was rendered. Reopen it in the editor and fix that block.`,
      };
    throw e;
  }
}
