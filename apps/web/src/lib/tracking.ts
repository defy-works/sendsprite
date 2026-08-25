import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Open/click tracking helpers (pure). Click targets are HMAC-signed so
 * `/t/c/:id?u=…&s=…` cannot be used as an open redirect.
 */

export const signClick = (emailId: string, url: string, secret: string) =>
  createHmac("sha256", secret)
    .update(`${emailId}\n${url}`)
    .digest("base64url")
    .slice(0, 32);

export function verifyClick(
  emailId: string,
  url: string,
  sig: string,
  secret: string,
): boolean {
  const a = Buffer.from(signClick(emailId, url, secret));
  const b = Buffer.from(sig ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const pixelTag = (emailId: string, base: string) =>
  `<img src="${base}/t/o/${emailId}.gif" width="1" height="1" alt="" style="display:none;max-width:1px;max-height:1px" />`;

/**
 * Rewrites `href="http(s)://…"` inside anchor tags to signed click URLs.
 * Leaves mailto:, tel:, #anchors, non-anchor tags (`<link href>`), `data-href`
 * attributes, and links already pointing at the tracker.
 */
export function wrapLinks(
  html: string,
  emailId: string,
  base: string,
  secret: string,
): string {
  return html.replace(
    // `[\s"']href=` so `data-href=` (and any other `*-href`) is left alone.
    /(<a\b[^>]*?[\s"']href=)(["'])(https?:\/\/[^"']+)\2/gi,
    (_m: string, pre: string, q: string, url: string) => {
      if (url.startsWith(`${base}/t/`)) return `${pre}${q}${url}${q}`;
      const u = url.replace(/&amp;/g, "&");
      return `${pre}${q}${base}/t/c/${emailId}?u=${encodeURIComponent(u)}&s=${signClick(emailId, u, secret)}${q}`;
    },
  );
}

export function injectPixel(html: string, emailId: string, base: string) {
  const tag = pixelTag(emailId, base);
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${tag}</body>`)
    : html + tag;
}

/**
 * Inverse of `wrapLinks` + `injectPixel` for a stored body: drops our open
 * pixel and restores each `/t/c/:id?u=…` href to its original URL so a
 * resend can be re-tracked under the new email id. `&` in the restored href
 * is written as `&amp;` (the attribute-safe form).
 */
export function unwrapTracking(html: string, base: string): string {
  const b = base.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const pixel = new RegExp(`<img src="${b}/t/o/[^"]+\\.gif"[^>]*>`, "gi");
  const click = new RegExp(
    `(href=)(["'])${b}/t/c/[^"'?]+\\?u=([^&"']*)&s=[^"']*\\2`,
    "gi",
  );
  return html
    .replace(pixel, "")
    .replace(
      click,
      (_m: string, pre: string, q: string, u: string) =>
        `${pre}${q}${decodeURIComponent(u).replace(/&/g, "&amp;")}${q}`,
    );
}
