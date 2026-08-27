"use client";
import { useEffect, useRef, type CSSProperties } from "react";
import { cn } from "@/lib/cn";

/**
 * A heading, typed where it sits.
 *
 * A heading's text is a plain string in the contract — no marks, no markup —
 * so this is deliberately not the Tiptap editor the paragraph uses. It is a
 * `contentEditable` that reads back `textContent` and nothing else: a paste
 * carrying markup arrives as its text, because that is all `textContent` can
 * be, and there is no serialiser between here and the field to get wrong.
 *
 * Editing the heading in the inspector still works and is still where its size
 * and colour live. This is about the first thing anyone tries on a canvas that
 * shows the email: clicking the words and typing.
 */
export function PlainEditable({
  as: Tag,
  value,
  readOnly,
  style,
  className,
  inert = false,
  onChange,
}: {
  /**
   * The element to render, which is the element the email will have.
   *
   * A heading on the canvas has to stay an `h1`/`h2`/`h3`: it is a heading in
   * the document being edited, and rendering it as a `div` with a textbox role
   * both lies to a screen reader and makes the canvas structurally different
   * from the thing it is previewing. Its own text is its accessible name, so
   * there is no label to give it.
   */
  as: "h1" | "h2" | "h3";
  value: string;
  readOnly: boolean;
  style?: CSSProperties;
  className?: string;
  /** Take no pointer events — while a block is being dragged over the canvas. */
  inert?: boolean;
  onChange: (text: string) => void;
}) {
  const ref = useRef<HTMLHeadingElement>(null);

  /*
   * Written to the DOM only when it differs from what is already there.
   *
   * React cannot own the contents of a contentEditable: re-rendering it on
   * every keystroke moves the caret to the start. So the element holds the
   * text, this effect only corrects it when the value changed underneath —
   * an undo, a layout insert, a switch to another block — and the guard is
   * what stops that correction firing on the user's own typing.
   */
  useEffect(() => {
    const el = ref.current;
    if (el && el.textContent !== value) el.textContent = value;
  }, [value]);

  return (
    <Tag
      ref={ref}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      spellCheck
      tabIndex={readOnly ? -1 : 0}
      style={style}
      className={cn("outline-none", inert && "pointer-events-none", className)}
      onInput={(e) => onChange(e.currentTarget.textContent ?? "")}
      onKeyDown={(e) => {
        // A heading is one line. Enter would insert a `<div>` or a `<br>` that
        // `textContent` then reads back as nothing, silently losing the break
        // the author thought they made.
        if (e.key === "Enter") e.preventDefault();
      }}
      onPaste={(e) => {
        // Plain text only, and inserted by hand: the browser's own paste puts
        // markup into the element even when the value read back is text, and
        // that markup is visible until the next correction.
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain").replace(/\s+/g, " ");
        document.execCommand("insertText", false, text);
      }}
    />
  );
}
