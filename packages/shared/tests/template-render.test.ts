import { describe, expect, it } from "vitest";
import {
  MAX_PLACEHOLDERS,
  MAX_RENDERED_CHARS,
  MAX_SUBJECT_CHARS,
  NO_CONTROL_CHARS,
  escapeHtml,
  placeholderCount,
  placeholderNames,
  renderTemplate,
} from "../src/index";

const base = {
  subject: "Hi {{ name }}",
  bodyHtml: "<p>Hello {{name}}</p>",
  bodyText: "Hello {{name}}",
};

describe("escapeHtml", () => {
  it("escapes the seven characters that matter and nothing else", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href&#61;&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
    expect(escapeHtml("plain — text 한글 ✉")).toBe("plain — text 한글 ✉");
  });

  it("escapes the backtick and the equals sign, for unquoted attributes", () => {
    expect(escapeHtml("a`b=c")).toBe("a&#96;b&#61;c");
  });

  it("escapes an entity's ampersand too, so nothing round-trips silently", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

describe("NO_CONTROL_CHARS", () => {
  it("is the one rule the renderer and the contracts share", () => {
    expect(NO_CONTROL_CHARS.test("A normal subject — with punctuation!")).toBe(
      true,
    );
    for (const code of [0x00, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b, 0x7f])
      expect(NO_CONTROL_CHARS.test(`x${String.fromCharCode(code)}y`)).toBe(
        false,
      );
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

  it("is not affected by an earlier scan of the same pattern", () => {
    // A shared `/g` regex would carry `lastIndex` between calls and start the
    // second scan mid-string.
    expect(placeholderNames("{{a}} {{b}}")).toEqual(["a", "b"]);
    expect(placeholderNames("{{a}} {{b}}")).toEqual(["a", "b"]);
    expect(placeholderCount("{{a}} {{b}}")).toBe(2);
    expect(placeholderNames("{{a}} {{b}}")).toEqual(["a", "b"]);
  });
});

describe("placeholderCount", () => {
  it("counts occurrences, not distinct names", () => {
    expect(placeholderCount("{{a}} {{a}} {{ a }} {{b}}")).toBe(4);
    expect(placeholderCount("no variables here")).toBe(0);
    expect(placeholderCount("{{1bad}} {{unclosed")).toBe(0);
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
      `<a href="&quot; onmouseover&#61;&quot;alert(1)" title='&#39; onfocus&#61;&#39;alert(1)'>go</a>`,
    );
    // No quote closes the attribute and no `=` assigns a new one.
    expect(r.data.html).not.toMatch(/onmouseover=/);
    expect(r.data.html).not.toMatch(/onfocus=/);
  });

  it("a value cannot become an attribute in an unquoted or backtick-delimited one", () => {
    const r = renderTemplate(
      {
        subject: "s",
        bodyHtml: "<a href={{u}}>go</a><img src=`{{v}}`>",
        bodyText: null,
      },
      { u: "x onmouseover=alert(1)", v: "x` onerror=`alert(1)" },
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.html).toBe(
      "<a href=x onmouseover&#61;alert(1)>go</a>" +
        "<img src=`x&#96; onerror&#61;&#96;alert(1)`>",
    );
    // `onmouseover&#61;…` is one inert attribute *name* — names are not
    // entity-decoded — and the backtick value never closes its delimiter.
    expect(r.data.html).not.toMatch(/onmouseover=/);
    expect(r.data.html).not.toMatch(/onerror=/);
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

  it("refuses every C0 control character and DEL, not only CR and LF", () => {
    // NUL truncates the value in a C-string agent downstream and ESC is
    // RFC 2047's charset-switching lead-in; neither is a line break.
    for (const code of [0x00, 0x09, 0x0b, 0x0c, 0x1b, 0x7f]) {
      const name = `x${String.fromCharCode(code)}y`;
      const r = renderTemplate(base, { name });
      expect(r.ok, `U+${code.toString(16).padStart(4, "0")}`).toBe(false);
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

  it("accepts a subject of exactly MAX_SUBJECT_CHARS and refuses one more", () => {
    const at = renderTemplate(
      { ...base, subject: "{{name}}" },
      { name: "x".repeat(MAX_SUBJECT_CHARS) },
    );
    expect(at.ok).toBe(true);
    const over = renderTemplate(
      { ...base, subject: "{{name}}" },
      { name: "x".repeat(MAX_SUBJECT_CHARS + 1) },
    );
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error("unreachable");
    expect(over.error).toMatch(/at most 998 characters/);
  });

  it("returns the subject trimmed", () => {
    const r = renderTemplate(
      { subject: "  Hi {{name}}  ", bodyHtml: "x", bodyText: null },
      { name: "Mingu" },
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.subject).toBe("Hi Mingu");
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

  it("treats an empty or whitespace-only value as missing", () => {
    // A blank CSV cell is `""`, not `undefined` — the case the refusal exists
    // for is the one that arrives as an empty string.
    const t = { subject: "s", bodyHtml: "Hi {{a}}, {{b}}", bodyText: null };
    const r = renderTemplate(t, { a: "", b: "   " });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.missing).toEqual(["a", "b"]);
  });

  it("lets a declared default cover an empty, whitespace or null value", () => {
    const schema = { variables: [{ name: "name", default: "there" }] };
    for (const value of ["", "   ", null, undefined]) {
      const r = renderTemplate(base, { name: value }, schema);
      expect(r.ok, JSON.stringify(value)).toBe(true);
      if (!r.ok) throw new Error("unreachable");
      expect(r.data.subject).toBe("Hi there");
    }
  });

  it('honours an explicit empty default as the way to ask for ""', () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "[{{a}}]", bodyText: null },
      { a: "" },
      { variables: [{ name: "a", default: "" }] },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.html).toBe("[]");
  });

  it("uses a declared default for a variable the caller omitted", () => {
    const r = renderTemplate(
      base,
      {},
      {
        variables: [{ name: "name", type: "string", default: "there" }],
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

  it("does not walk into an array, not even for its length", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{a.length}}", bodyText: null },
      { a: [1, 2, 3] },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.missing).toEqual(["a.length"]);
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

  it("reads each distinct variable exactly once, whatever the accessor does", () => {
    // The divergence this guards: an accessor that answers differently per
    // read could make the subject say one thing and the HTML another, in the
    // same call — the preview/send disagreement the module exists to prevent.
    let reads = 0;
    const values = {
      get name() {
        reads += 1;
        return reads === 1 ? "SAFE" : "<script>alert(1)</script>";
      },
    };
    const r = renderTemplate(base, values);
    if (!r.ok) throw new Error("unreachable");
    expect(reads).toBe(1);
    expect(r.data.subject).toBe("Hi SAFE");
    expect(r.data.html).toBe("<p>Hello SAFE</p>");
    expect(r.data.text).toBe("Hello SAFE");
  });

  it("reads a repeated placeholder once, not once per occurrence", () => {
    let reads = 0;
    const values = {
      get a() {
        reads += 1;
        return "x";
      },
    };
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{a}}{{a}}{{a}}{{a}}", bodyText: "{{a}}" },
      values,
    );
    expect(r.ok).toBe(true);
    expect(reads).toBe(1);
  });

  it("returns a refusal rather than throwing when reading a value throws", () => {
    const thrower = {
      get name(): string {
        throw new Error("boom");
      },
    };
    const r = renderTemplate(base, thrower);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.invalid).toEqual(["name"]);

    const trapped = new Proxy({} as Record<string, unknown>, {
      getOwnPropertyDescriptor() {
        throw new Error("trap");
      },
    });
    const p = renderTemplate(base, trapped);
    expect(p.ok).toBe(false);
    if (p.ok) throw new Error("unreachable");
    expect(p.invalid).toEqual(["name"]);
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

  it("never interprets a replacement pattern in a value", () => {
    // Pins the property, not the implementation: a refactor to a string-map
    // `replace` would make `$&` re-insert the match and `$1` the capture.
    const v = "$& $` $' $1 $$";
    const r = renderTemplate(
      { subject: "[{{v}}]", bodyHtml: "[{{v}}]", bodyText: "[{{v}}]" },
      { v },
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.subject).toBe(`[${v}]`);
    expect(r.data.text).toBe(`[${v}]`);
    expect(r.data.html).toBe("[$&amp; $&#96; $&#39; $1 $$]");
  });

  it("refuses a value whose declared type does not match", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{n}}", bodyText: null },
      { n: "12" },
      { variables: [{ name: "n", type: "number" }] },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.invalid).toEqual(["n"]);
  });

  it("checks the declared type in the other two directions as well", () => {
    const asString = renderTemplate(
      { subject: "s", bodyHtml: "{{n}}", bodyText: null },
      { n: 12 },
      { variables: [{ name: "n", type: "string" }] },
    );
    expect(asString.ok).toBe(false);
    if (asString.ok) throw new Error("unreachable");
    expect(asString.invalid).toEqual(["n"]);

    const asBoolean = renderTemplate(
      { subject: "s", bodyHtml: "{{b}}", bodyText: null },
      { b: "true" },
      { variables: [{ name: "b", type: "boolean" }] },
    );
    expect(asBoolean.ok).toBe(false);
    if (asBoolean.ok) throw new Error("unreachable");
    expect(asBoolean.invalid).toEqual(["b"]);

    const matching = renderTemplate(
      { subject: "s", bodyHtml: "{{b}}", bodyText: null },
      { b: true },
      { variables: [{ name: "b", type: "boolean" }] },
    );
    expect(matching.ok).toBe(true);
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

  it("accepts a body of exactly MAX_RENDERED_CHARS and refuses one more", () => {
    const t = { subject: "s", bodyHtml: "{{a}}", bodyText: null };
    expect(renderTemplate(t, { a: "x".repeat(MAX_RENDERED_CHARS) }).ok).toBe(
      true,
    );
    expect(
      renderTemplate(t, { a: "x".repeat(MAX_RENDERED_CHARS + 1) }).ok,
    ).toBe(false);
  });

  it("gives up part-way through a field rather than building it all first", () => {
    // 100 occurrences of 100 KB is 10M characters; the refusal must arrive
    // without ever assembling them.
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{a}}".repeat(100), bodyText: null },
      { a: "x".repeat(100_000) },
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

  it("treats an undefined bodyText as absent instead of throwing", () => {
    // A nullable column read through `?? undefined` produces exactly this.
    const r = renderTemplate({
      subject: "s",
      bodyHtml: "x",
      bodyText: undefined as unknown as null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.text).toBeNull();
  });

  it("refuses a non-string field rather than throwing", () => {
    for (const bad of [
      { subject: null, bodyHtml: "x", bodyText: null },
      { subject: "s", bodyHtml: 42, bodyText: null },
      { subject: "s", bodyHtml: "x", bodyText: {} },
    ]) {
      const r = renderTemplate(
        bad as unknown as Parameters<typeof renderTemplate>[0],
      );
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.error).toMatch(/must be text/i);
    }
  });
});
