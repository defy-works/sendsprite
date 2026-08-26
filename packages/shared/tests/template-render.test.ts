import { describe, expect, it } from "vitest";
import {
  MAX_PLACEHOLDERS,
  escapeHtml,
  placeholderNames,
  renderTemplate,
} from "../src/index";

const base = {
  subject: "Hi {{ name }}",
  bodyHtml: "<p>Hello {{name}}</p>",
  bodyText: "Hello {{name}}",
};

describe("escapeHtml", () => {
  it("escapes the five characters that matter and nothing else", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
    expect(escapeHtml("plain — text 한글 ✉")).toBe("plain — text 한글 ✉");
  });

  it("escapes an entity's ampersand too, so nothing round-trips silently", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

describe("placeholderNames", () => {
  it("finds names once each, in order, tolerating whitespace", () => {
    expect(
      placeholderNames("{{a}} {{ b }} {{a}} {{ user.first_name }}"),
    ).toEqual(["a", "b", "user.first_name"]);
  });

  it("ignores anything that is not a well-formed placeholder", () => {
    expect(
      placeholderNames("{{ }} {{1bad}} {{a-b}} { {a} } {{unclosed"),
    ).toEqual([]);
  });

  it("accepts four dotted segments and no more", () => {
    expect(placeholderNames("{{a.b.c.d}}")).toEqual(["a.b.c.d"]);
    expect(placeholderNames("{{a.b.c.d.e}}")).toEqual([]);
    expect(placeholderNames("{{a.0}}")).toEqual([]);
  });
});

describe("renderTemplate", () => {
  it("substitutes into all three fields", () => {
    const r = renderTemplate(base, { name: "Mingu" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data).toEqual({
      subject: "Hi Mingu",
      html: "<p>Hello Mingu</p>",
      text: "Hello Mingu",
    });
  });

  it("HTML-escapes values in bodyHtml and leaves bodyText and subject alone", () => {
    const r = renderTemplate(base, { name: `<b>&"x"</b>` });
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.html).toBe(
      "<p>Hello &lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;</p>",
    );
    expect(r.data.text).toBe(`Hello <b>&"x"</b>`);
    expect(r.data.subject).toBe(`Hi <b>&"x"</b>`);
  });

  it("a value cannot break out of a double- or single-quoted attribute", () => {
    const r = renderTemplate(
      {
        subject: "s",
        bodyHtml: `<a href="{{url}}" title='{{title}}'>go</a>`,
        bodyText: null,
      },
      {
        url: `" onmouseover="alert(1)`,
        title: `' onfocus='alert(1)`,
      },
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.html).toBe(
      `<a href="&quot; onmouseover=&quot;alert(1)" title='&#39; onfocus=&#39;alert(1)'>go</a>`,
    );
    // The text survives, but no quote closes its attribute, so neither value
    // becomes an attribute of its own — that is the whole property.
    expect(r.data.html).not.toMatch(/onmouseover="/);
    expect(r.data.html).not.toMatch(/onfocus='/);
  });

  it("a value cannot close the surrounding element or open a new one", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "<div>{{v}}</div>", bodyText: null },
      { v: "</div><script>alert(1)</script>" },
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.html).toBe(
      "<div>&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt;</div>",
    );
    expect(r.data.html).not.toMatch(/<script/);
  });

  it("refuses a rendered subject carrying CR or LF (header injection)", () => {
    const r = renderTemplate(base, { name: "x\r\nBcc: evil@x.io" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toMatch(/line breaks/i);
  });

  it("refuses a lone CR, a lone LF, and a trailing break that trimming would hide", () => {
    for (const name of ["x\ry", "x\ny", "x\n", "x\r\n", "\nx"]) {
      const r = renderTemplate(base, { name });
      expect(r.ok, JSON.stringify(name)).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.error).toMatch(/line breaks/i);
    }
  });

  it("refuses a line break that arrives through a declared default", () => {
    const r = renderTemplate(
      base,
      {},
      { variables: [{ name: "name", default: "x\r\nBcc: evil@x.io" }] },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toMatch(/line breaks/i);
  });

  it("refuses an empty or over-long rendered subject", () => {
    expect(
      renderTemplate({ ...base, subject: "{{name}}" }, { name: "  " }).ok,
    ).toBe(false);
    expect(
      renderTemplate(
        { ...base, subject: "{{name}}" },
        { name: "x".repeat(999) },
      ).ok,
    ).toBe(false);
  });

  it("names every missing variable instead of rendering an empty string", () => {
    const r = renderTemplate(
      { subject: "{{a}}", bodyHtml: "{{b}} {{c}}", bodyText: null },
      { b: "1" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.missing).toEqual(["a", "c"]);
    expect(r.error).toMatch(/a, c/);
  });

  it("uses a declared default for a variable the caller omitted", () => {
    const r = renderTemplate(
      base,
      {},
      {
        variables: [
          { name: "name", type: "string", required: false, default: "there" },
        ],
      },
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.subject).toBe("Hi there");
  });

  it("escapes a default in bodyHtml exactly as it escapes a caller value", () => {
    const r = renderTemplate(
      base,
      {},
      { variables: [{ name: "name", default: "<b>&</b>" }] },
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.html).toBe("<p>Hello &lt;b&gt;&amp;&lt;/b&gt;</p>");
    expect(r.data.text).toBe("Hello <b>&</b>");
  });

  it("renders numbers and booleans, refuses objects and arrays", () => {
    const t = { subject: "s", bodyHtml: "{{n}}/{{b}}", bodyText: null };
    const ok = renderTemplate(t, { n: 42, b: false });
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.data.html).toBe("42/false");
    const bad = renderTemplate(t, { n: { deep: 1 }, b: [1, 2] });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.invalid).toEqual(["n", "b"]);
  });

  it("refuses functions, symbols and bigints rather than stringifying them", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{f}}{{sym}}{{big}}", bodyText: null },
      { f: () => "x", sym: Symbol("s"), big: 10n },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.invalid).toEqual(["f", "sym", "big"]);
    expect(r.error).toMatch(/not a string, number or boolean/);
  });

  it("treats null and NaN as missing rather than as values", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{a}}{{b}}", bodyText: null },
      {
        a: null,
        b: Number.NaN,
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.missing).toEqual(["a", "b"]);
  });

  it("treats Infinity as missing too", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{a}}", bodyText: null },
      { a: Number.POSITIVE_INFINITY },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.missing).toEqual(["a"]);
  });

  it("walks dotted paths, and only through plain objects", () => {
    const t = { subject: "s", bodyHtml: "{{user.name}}", bodyText: null };
    const ok = renderTemplate(t, { user: { name: "Mingu" } });
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.data.html).toBe("Mingu");
    // A prototype-chain lookup must not resolve: `constructor` is not data.
    const proto = renderTemplate(
      { subject: "s", bodyHtml: "{{a.constructor}}", bodyText: null },
      { a: {} },
    );
    expect(proto.ok).toBe(false);
  });

  it("resolves nothing through __proto__, constructor or prototype", () => {
    for (const path of [
      "a.__proto__",
      "a.constructor",
      "a.constructor.name",
      "a.prototype",
      "a.toString",
      "a.hasOwnProperty",
    ]) {
      const r = renderTemplate(
        { subject: "s", bodyHtml: `{{${path}}}`, bodyText: null },
        { a: {} },
      );
      expect(r.ok, path).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.missing, path).toEqual([path]);
    }
  });

  it("does not read inherited properties of the values object", () => {
    const inherited = renderTemplate(
      { subject: "s", bodyHtml: "{{secret}}", bodyText: null },
      Object.create({ secret: "leaked" }) as Record<string, unknown>,
    );
    expect(inherited.ok).toBe(false);
    if (inherited.ok) throw new Error("unreachable");
    expect(inherited.missing).toEqual(["secret"]);

    const nested = renderTemplate(
      { subject: "s", bodyHtml: "{{a.secret}}", bodyText: null },
      { a: Object.create({ secret: "leaked" }) as Record<string, unknown> },
    );
    expect(nested.ok).toBe(false);
    if (nested.ok) throw new Error("unreachable");
    expect(nested.missing).toEqual(["a.secret"]);
  });

  it("does not re-scan substituted text (no expansion bomb)", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{a}}", bodyText: null },
      { a: "{{a}}{{a}}" },
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.html).toBe("{{a}}{{a}}");
  });

  it("does not expand a placeholder that arrives inside another value", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{a}}", bodyText: null },
      { a: "{{b}}", b: "SECRET" },
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.html).toBe("{{b}}");
    expect(r.data.html).not.toContain("SECRET");
  });

  it("refuses a value whose declared type does not match", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{n}}", bodyText: null },
      { n: "12" },
      { variables: [{ name: "n", type: "number", required: true }] },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.invalid).toEqual(["n"]);
  });

  it("refuses a body with more placeholders than MAX_PLACEHOLDERS", () => {
    const many = "{{a}}".repeat(MAX_PLACEHOLDERS + 1);
    expect(
      renderTemplate(
        { subject: "s", bodyHtml: many, bodyText: null },
        { a: "x" },
      ).ok,
    ).toBe(false);
  });

  it("allows exactly MAX_PLACEHOLDERS occurrences in one field", () => {
    const many = "{{a}}".repeat(MAX_PLACEHOLDERS);
    const r = renderTemplate(
      { subject: "s", bodyHtml: many, bodyText: null },
      { a: "x" },
    );
    expect(r.ok).toBe(true);
  });

  it("refuses a render that blows past the stored-body limit", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{a}}", bodyText: null },
      { a: "x".repeat(5_000_001) },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toMatch(/too large/i);
  });

  it("applies the stored-body limit to bodyText as well as bodyHtml", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "x", bodyText: "{{a}}" },
      { a: "x".repeat(5_000_001) },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toMatch(/too large/i);
  });

  it("passes a null bodyText through as null", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "x", bodyText: null },
      {},
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.text).toBeNull();
  });
});
