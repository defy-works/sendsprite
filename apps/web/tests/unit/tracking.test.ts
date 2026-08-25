import { describe, expect, it } from "vitest";
import {
  wrapLinks,
  pixelTag,
  injectPixel,
  signClick,
  verifyClick,
} from "@/lib/tracking";

const base = "https://mail.acme.com";
const secret = "s".repeat(32);

describe("tracking", () => {
  it("rewrites http(s) hrefs to signed click urls and leaves mailto/anchors", () => {
    const html =
      '<a href="https://x.io/a?b=1">x</a> <a href="mailto:a@b">m</a> <a href="#top">t</a>';
    const out = wrapLinks(html, "em_1", base, secret);
    expect(out).toContain(
      `${base}/t/c/em_1?u=${encodeURIComponent("https://x.io/a?b=1")}&s=`,
    );
    expect(out).toContain('href="mailto:a@b"');
    expect(out).toContain('href="#top"');
  });
  it("does not double-wrap links that already point at the tracker", () => {
    const once = wrapLinks(
      '<a href="https://x.io">x</a>',
      "em_1",
      base,
      secret,
    );
    expect(wrapLinks(once, "em_1", base, secret)).toBe(once);
  });
  it("decodes &amp; before signing so the redirect target verifies", () => {
    const out = wrapLinks(
      '<a href="https://x.io/?a=1&amp;b=2">x</a>',
      "em_1",
      base,
      secret,
    );
    const m = /u=([^&"]+)&s=([^"]+)"/.exec(out);
    const url = decodeURIComponent(m![1]!);
    expect(url).toBe("https://x.io/?a=1&b=2");
    expect(verifyClick("em_1", url, m![2]!, secret)).toBe(true);
  });
  it("signs and verifies click targets", () => {
    const s = signClick("em_1", "https://x.io", secret);
    expect(verifyClick("em_1", "https://x.io", s, secret)).toBe(true);
    expect(verifyClick("em_1", "https://evil.io", s, secret)).toBe(false);
    expect(verifyClick("em_1", "https://x.io", "", secret)).toBe(false);
  });
  it("pixelTag points at /t/o/<id>.gif and injectPixel places it before </body>", () => {
    expect(pixelTag("em_1", base)).toContain(`${base}/t/o/em_1.gif`);
    expect(injectPixel("<p>hi</p>", "em_1", base)).toMatch(/<p>hi<\/p><img /);
    expect(injectPixel("<body><p>hi</p></body>", "em_1", base)).toMatch(
      /<img [^>]+><\/body>$/,
    );
  });
});
