/**
 * Accepts only same-origin absolute paths for post-auth redirects.
 * Rejects protocol-relative (`//x`), backslash tricks (`/\x`) and encoded
 * slashes that some routers decode into the same thing.
 */
export function safeNext(raw: unknown, fallback = "/app"): string {
  if (typeof raw !== "string") return fallback;
  if (!/^\/(?![/\\])/.test(raw)) return fallback;
  if (raw.includes("\\")) return fallback;
  if (/%2f|%5c/i.test(raw)) return fallback;
  return raw;
}
