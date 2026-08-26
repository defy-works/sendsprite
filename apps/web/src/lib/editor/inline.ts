import {
  MAX_BLOCK_TEXT_CHARS,
  SafeUrl,
  TextBlock,
  escapeHtml,
} from "@sendsprite/shared";

/**
 * The rich-text serialiser: a ProseMirror document to the inline HTML a `text`
 * block stores.
 *
 * Lifted out of `campaigns/preview.ts` when templates started using the same
 * editor, unchanged. Its file comment is worth repeating in one line, because
 * it is the reason this module exists at all rather than a call to
 * `editor.getHTML()`: **this is a security boundary.** `TextBlock.html` is the
 * one field the renderer emits unescaped, and what makes that safe is not the
 * Tiptap configuration — a dependency default a minor release could widen —
 * but the fact that this file writes the markup itself from an allow-list of
 * three marks and one node, and checks the result against `TextBlock` before
 * returning it. It cannot return a string the contract refuses.
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
