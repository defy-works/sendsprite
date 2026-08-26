/**
 * `sendsprite/react`: React Email primitives re-exported for convenience, plus
 * `renderEmail`. Server-side only (no hooks) — render in a route handler or
 * server action, then send the html/text.
 */
export * from "@react-email/components";
export { renderEmail, type Rendered } from "./render";
