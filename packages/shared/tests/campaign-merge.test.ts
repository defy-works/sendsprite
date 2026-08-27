import { describe, expect, it } from "vitest";
import { renderCampaignFields } from "../src/template";

const F = (
  over: Partial<{ subject: string; html: string; text: string }> = {},
) => ({
  subject: "",
  html: "",
  text: "",
  ...over,
});
const ok = (r: ReturnType<typeof renderCampaignFields>) => {
  if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
  return r;
};

describe("renderCampaignFields", () => {
  it("substitutes a scalar and reads a dotted property path", () => {
    const r = ok(
      renderCampaignFields(
        F({
          subject: "Hi {{ firstName }}",
          html: "<p>{{ firstName }} at {{ properties.company }}</p>",
          text: "{{ firstName }} at {{ properties.company }}",
        }),
        { firstName: "Ada", properties: { company: "Analytical" } },
      ),
    );
    expect(r.subject).toBe("Hi Ada");
    expect(r.html).toBe("<p>Ada at Analytical</p>");
    expect(r.text).toBe("Ada at Analytical");
  });

  it("HTML-escapes a value in html, leaves it raw in text", () => {
    const value = '<script>&"';
    const r = ok(
      renderCampaignFields(F({ html: "{{ x }}", text: "{{ x }}" }), {
        x: value,
      }),
    );
    expect(r.html).toBe("&lt;script&gt;&amp;&quot;");
    expect(r.text).toBe(value);
  });

  it("a missing value is empty, or the author fallback", () => {
    const noFallback = ok(
      renderCampaignFields(F({ html: "Hi {{ firstName }}," }), {}),
    );
    expect(noFallback.html).toBe("Hi ,");
    const withFallback = ok(
      renderCampaignFields(
        F({ html: "Hi {{ firstName }}," }),
        {},
        {
          firstName: "there",
        },
      ),
    );
    expect(withFallback.html).toBe("Hi there,");
  });

  it("treats blank, null and a non-scalar the same as missing", () => {
    const r = ok(
      renderCampaignFields(
        F({ html: "[{{ a }}][{{ b }}][{{ c }}]" }),
        { a: "   ", b: null, c: { nested: 1 } },
        { c: "fallback" },
      ),
    );
    // a: whitespace-only → empty (no fallback); b: null → empty; c: object → fallback
    expect(r.html).toBe("[][][fallback]");
  });

  it("strips control characters from a value merged into the subject", () => {
    const r = ok(
      renderCampaignFields(F({ subject: "Hi {{ name }}" }), {
        name: "Ada\r\nBcc: evil@example.com",
      }),
    );
    expect(r.subject).toBe("Hi AdaBcc: evil@example.com");
    expect(r.subject).not.toMatch(/[\r\n]/);
  });

  it("renders numbers and booleans", () => {
    const r = ok(
      renderCampaignFields(F({ text: "{{ n }} {{ b }}" }), { n: 3, b: true }),
    );
    expect(r.text).toBe("3 true");
  });

  it("does not expand a placeholder that appears inside a value", () => {
    const r = ok(
      renderCampaignFields(F({ html: "{{ a }}" }), { a: "{{ b }}", b: "X" }),
    );
    expect(r.html).toBe("{{ b }}");
  });

  it("returns the fields untouched when there is no placeholder", () => {
    const fields = F({ subject: "Sale", html: "<p>Hi</p>", text: "Hi" });
    const r = ok(renderCampaignFields(fields, { firstName: "Ada" }));
    expect(r).toEqual(fields);
  });

  it("errors when a substitution pushes the subject past the length cap", () => {
    const r = renderCampaignFields(F({ subject: "{{ x }}" }), {
      x: "a".repeat(1100),
    });
    expect("error" in r && r.error).toMatch(/subject is too long/);
  });

  it("does not resolve prototype-chain names", () => {
    const r = ok(
      renderCampaignFields(F({ html: "[{{ a.constructor }}]" }), { a: {} }),
    );
    expect(r.html).toBe("[]");
  });
});
