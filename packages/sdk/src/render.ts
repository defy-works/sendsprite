import type { ReactElement } from "react";

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
