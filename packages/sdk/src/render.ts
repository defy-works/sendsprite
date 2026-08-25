import type { ReactElement } from "react";
import type { ReactElementLike } from "./types";

export interface Rendered {
  html: string;
  text: string;
}

/**
 * Renders a React Email element to `html` and plain `text`. `@react-email/render`
 * is an optional peer, so it is imported lazily; the root entry never depends on it.
 */
export async function renderEmail(element: ReactElement): Promise<Rendered> {
  let mod: typeof import("@react-email/render");
  try {
    mod = await import("@react-email/render");
  } catch {
    throw new Error(
      "sendsprite: sending `react` requires the optional peer dependency — install @react-email/render (and @react-email/components for the primitives).",
    );
  }
  const [html, text] = await Promise.all([
    mod.render(element),
    mod.render(element, { plainText: true }),
  ]);
  return { html, text };
}

/**
 * Internal bridge for `emails.send({ react })`. `SendEmailOptions.react` is
 * typed structurally so `dist/index.d.ts` needs no `@types/react`; the value
 * is a real element at runtime, so the cast is safe.
 */
export const renderElementLike = (
  element: ReactElementLike,
): Promise<Rendered> => renderEmail(element as unknown as ReactElement);
