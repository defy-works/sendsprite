"use client";
import { Extension } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit, { type StarterKitOptions } from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { SafeUrl } from "@sendsprite/shared";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { serializeInline } from "../../preview";

/**
 * The inside of a `text` block: Tiptap, scoped to three inline marks
 * (Decision 7).
 *
 * dnd-kit owns the order of blocks; this owns the inside of one of them. The
 * document structure is the typed block list, not Tiptap's document — which is
 * why nothing here ever calls `editor.getHTML()`. What leaves this component
 * is `serializeInline(editor.getJSON())`, an allow-list serialiser that writes
 * the markup itself and is guaranteed to produce a string `CampaignBlock`
 * accepts. See `campaigns/preview.ts`; that file is the security boundary and
 * this one is defence in depth.
 *
 * Defence in depth still has to be real, though: an editor that lets somebody
 * paste a bulleted list and then silently drops it on save is a bad editor,
 * and a widened schema is one release away from being the only thing between
 * a paste and an unescaped `<script>` if the serialiser is ever "simplified"
 * to `getHTML()`. So the schema is pinned two ways.
 */

/**
 * Every StarterKit extension, decided one by one.
 *
 * The type is what makes this a control rather than a comment. It is the full
 * `StarterKitOptions` (less the two that cannot be configured, only removed),
 * **not** the `Partial<…>` that `configure` accepts — so a Tiptap release that
 * adds a node or a mark to the kit fails `bun run typecheck` with "property
 * missing" until somebody decides about it. A minor upgrade cannot widen what
 * a campaign body may contain by default.
 *
 * The `@tiptap/*` versions in `package.json` are pinned exactly, without a
 * caret, for the same reason and one more: `@tiptap/react` peer-depends on
 * `@tiptap/core` and `@tiptap/pm` at an *exact* version, so a caret range that
 * let the three drift apart would break resolution anyway. Upgrading Tiptap is
 * a deliberate act here, and the missing-property error below is the review it
 * has to pass.
 *
 * `document` and `text` are omitted because their option type is the literal
 * `false`: they can only be switched off, and switching them off leaves no
 * schema at all. They are the two the editor needs and the two nothing can
 * configure, so there is nothing to decide.
 */
const STARTER_KIT: Omit<StarterKitOptions, "document" | "text"> = {
  // The entire node and mark vocabulary of a text block. Bold serialises to
  // `<strong>`, italic to `<em>`, a hard break to `<br />` — the three the
  // contract admits.
  paragraph: {},
  hardBreak: {},
  bold: {},
  italic: {},

  // Behaviour, not content: these register no node and no mark.
  dropcursor: {},
  undoRedo: {},

  // Off. Each of these would put a node or a mark in the document that the
  // contract has no representation for.
  blockquote: false,
  bulletList: false,
  code: false,
  codeBlock: false,
  heading: false,
  horizontalRule: false,
  listItem: false,
  listKeymap: false,
  orderedList: false,
  strike: false,
  underline: false,
  // A trailing empty paragraph the user did not type; `serializeInline` would
  // drop it anyway, so the editor should not show it either.
  trailingNode: false,
  // A cursor position between block nodes. There are no block nodes here but
  // paragraphs, so it has nothing to select.
  gapcursor: false,
  // Configured below instead, so its URL rule is the contract's own.
  link: false,
};

/**
 * The link mark, refusing exactly what `SafeUrl` refuses.
 *
 * `isAllowedUri` is Tiptap's own XSS guard and it is pointed at the contract
 * rather than replaced: the editor and the API then agree on what a link may
 * be, so a URL the editor accepted cannot be one the save rejects, and a
 * `javascript:` URL never reaches the document in the first place.
 */
const LinkMark = Link.configure({
  autolink: true,
  linkOnPaste: true,
  openOnClick: false,
  markdownLinks: false,
  defaultProtocol: "https",
  // The renderer writes the anchor; nothing Tiptap puts on this element is
  // serialised, and an empty set keeps that obvious.
  HTMLAttributes: {},
  isAllowedUri: (url) => SafeUrl.safeParse(url).success,
});

/**
 * Enter inserts a line break instead of splitting the paragraph.
 *
 * A text block renders as one `<p>`, so a second paragraph has nowhere to go
 * but a `<br />` — `serializeInline` does exactly that with one it finds. Doing
 * it at the keystroke keeps the editor showing what the email will show,
 * rather than a paragraph gap that quietly closes up on save.
 */
const EnterIsLineBreak = Extension.create({
  name: "campaignEnterIsLineBreak",
  addKeyboardShortcuts() {
    return { Enter: () => this.editor.commands.setHardBreak() };
  },
});

const CONTENT_CLASS =
  "min-h-20 w-full rounded-md border border-white/12 bg-white/4 px-3 py-2 " +
  "text-sm leading-relaxed text-white whitespace-pre-wrap break-words " +
  "focus:outline-none [&_a]:underline [&_a]:decoration-indigo-400";

export function InlineEditor({
  value,
  readOnly,
  label,
  onChange,
}: {
  /** The stored inline HTML. Read once, on mount; this component owns it after. */
  value: string;
  readOnly: boolean;
  label: string;
  onChange: (html: string) => void;
}) {
  const [linkError, setLinkError] = useState<string | null>(null);
  // `useEditor` builds its instance once, so its `onUpdate` closes over the
  // first `onChange`. A ref is what keeps it pointing at the current one.
  const emit = useRef(onChange);
  emit.current = onChange;

  const editor = useEditor({
    extensions: [StarterKit.configure(STARTER_KIT), LinkMark, EnterIsLineBreak],
    content: value,
    editable: !readOnly,
    // Required under the App Router: the first render happens on the server,
    // where there is no DOM for ProseMirror to mount into.
    immediatelyRender: false,
    // The toolbar reflects the mark under the cursor, which only moves on a
    // transaction. Cheap here: one small editor per text block.
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { class: CONTENT_CLASS, "aria-label": label },
    },
    onUpdate: ({ editor: e }) => emit.current(serializeInline(e.getJSON())),
  });

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  if (!editor)
    return (
      <div className={cn(CONTENT_CLASS, "text-white/40")}>Loading editor…</div>
    );

  const applyLink = () => {
    setLinkError(null);
    const current = editor.getAttributes("link").href;
    const answer = window.prompt(
      "Link to (http://, https:// or mailto:). Leave empty to remove the link.",
      typeof current === "string" ? current : "",
    );
    if (answer === null) return;
    const raw = answer.trim();
    if (raw === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const parsed = SafeUrl.safeParse(raw);
    if (!parsed.success) {
      // The contract's own message, not a paraphrase: the author sees the
      // same sentence the API would have returned.
      setLinkError(parsed.error.issues[0]?.message ?? "That URL is not valid.");
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: parsed.data })
      .run();
  };

  const mark = (active: boolean) =>
    active ? "bg-indigo-500/25 text-white" : undefined;

  return (
    <div className="flex flex-col gap-2">
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className={mark(editor.isActive("bold"))}
            aria-pressed={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            Bold
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={mark(editor.isActive("italic"))}
            aria-pressed={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            Italic
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={mark(editor.isActive("link"))}
            aria-pressed={editor.isActive("link")}
            onClick={applyLink}
          >
            Link
          </Button>
          <span className="text-xs text-white/40">
            Bold, italic and links only — a campaign body has no other
            formatting.
          </span>
        </div>
      )}
      <EditorContent editor={editor} />
      {linkError && (
        <p role="alert" className="text-xs text-red-300">
          {linkError}
        </p>
      )}
    </div>
  );
}
