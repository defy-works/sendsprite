import type { ReactElement } from "react";
import type { ReactElementLike } from "./types";

export interface Rendered {
  html: string;
  text: string;
}

/**
 * Assembled at run time so no bundler can see a specifier here. `react-email`
 * is an *optional* peer: with a literal `import("@react-email/render")`,
 * Webpack and Turbopack resolve it while building a Next app that never sends
 * React email, and fail the build with `Module not found`.
 */
const RENDER_PACKAGE = ["@react-email", "render"].join("/");

const MISSING_MODULE =
  /Cannot find module|ERR_MODULE_NOT_FOUND|Failed to resolve|Failed to load/i;

/**
 * Distinguishes "not installed" from "installed but broken". Loaders wrap the
 * real failure (Node, Vite and bundlers all do), so follow the `cause` chain
 * rather than looking at the outermost message only.
 */
function isMissingModule(cause: unknown): boolean {
  for (let error = cause, depth = 0; error != null && depth < 5; depth++) {
    if (typeof error !== "object") return MISSING_MODULE.test(String(error));
    const { code, message: text } = error as {
      code?: unknown;
      message?: unknown;
    };
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      return true;
    }
    if (typeof text === "string" && MISSING_MODULE.test(text)) return true;
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Renders a React Email element to `html` and plain `text`. `@react-email/render`
 * is an optional peer, so it is imported lazily; the root entry never depends on it.
 */
export async function renderEmail(element: ReactElement): Promise<Rendered> {
  let mod: typeof import("@react-email/render");
  try {
    mod = (await import(
      /* webpackIgnore: true */ /* @vite-ignore */ RENDER_PACKAGE
    )) as typeof import("@react-email/render");
  } catch (cause) {
    // Only a resolution failure means "install the peer". Anything else — a
    // broken transitive dependency, an ESM/CJS mismatch, a throw during module
    // init — must reach the caller unchanged, or they debug the wrong problem.
    if (!isMissingModule(cause)) throw cause;
    throw new Error(
      "sendsprite: sending `react` requires the optional peer dependency — install @react-email/render (and @react-email/components for the primitives).",
      { cause },
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
 * is a real element at runtime, so the cast is safe once we have checked.
 */
export const renderElementLike = (
  element: ReactElementLike,
): Promise<Rendered> => {
  if (!isReactElement(element)) {
    throw new Error(
      "sendsprite: `react` must be a React element, e.g. react: <Email />",
    );
  }
  return renderEmail(element as unknown as ReactElement);
};

/**
 * Presence of `$$typeof`, not its value: React 19 changed the marker from a
 * symbol to `Symbol.for("react.transitional.element")`, and comparing values
 * would reject elements from a different React copy. Without this check a
 * plain object reaches react-dom and fails with the unhelpful "Objects are not
 * valid as a React child".
 */
const isReactElement = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "$$typeof" in value;
