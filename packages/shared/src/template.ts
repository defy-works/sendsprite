/**
 * The Sendsprite template renderer.
 *
 * Pure, dependency-free and browser-safe on purpose: the send path, the
 * `POST /templates/:slug/render` endpoint and the dashboard's live preview all
 * call this one function, so a preview cannot disagree with what is sent.
 *
 * The syntax is `{{ name }}` and nothing else — no helpers, no filters, no
 * conditionals, no loops, and **no unescaped form**. A template engine's value
 * is its expression language and its expression language is its attack
 * surface; this renders third-party data into HTML that is then emailed, so
 * there is deliberately no language to sandbox.
 *
 * Escaping is a property of the *field*:
 *   - `bodyHtml` HTML-escapes every substituted value;
 *   - `bodyText` does not (it is not markup);
 *   - `subject` does not, but the **rendered** result is re-checked for control
 *     characters, because `SendEmailInput`'s no-line-breaks rule only sees what
 *     the client sent and a rendered subject bypasses it by construction. That
 *     check is the header-injection guard.
 *
 * **What the escaping covers, and what it does not.** `escapeHtml` is written
 * for two contexts: element text, and an attribute value in any delimiter style
 * (double-quoted, single-quoted, backtick or unquoted). It is a value escaper,
 * not a sanitiser, and three contexts stay the author's responsibility:
 *   - Inside `<style>`, a value is genuinely injectable — CSS `url()` and
 *     `@import` need no HTML-special character — so a placeholder does not
 *     belong in a style element.
 *   - Inside `<script>`, entities are not decoded, so a value cannot close the
 *     element or inject code; it arrives corrupted instead. Also not a place
 *     for a placeholder, for a different reason.
 *   - A quoted `href="{{u}}"` still accepts `javascript:`. Mail clients do not
 *     execute it and every preview surface here renders inside
 *     `<iframe sandbox="">`; a URL-scheme filter is a recorded opener.
 */

/**
 * Placeholder: `{{ name }}` or `{{ a.b.c }}`, whitespace tolerated.
 *
 * A fresh object per call, never one shared instance: `matchAll` *inherits*
 * `lastIndex` from a `/g` regex, so a single future `.test()` elsewhere in this
 * file would make `placeholderNames` silently start scanning mid-string. That
 * function is what the template editor lists variables from and what
 * `api/templates.ts` validates schema coverage with, so a name it fails to
 * report becomes a render refusal in production.
 */
const placeholder = () =>
  /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3})\s*\}\}/g;

/** Placeholders allowed in one field. A template is authored, not generated. */
export const MAX_PLACEHOLDERS = 500;
/** Matches the `html`/`text` bound in `SendEmailInput`, so a render cannot produce an unstorable body. */
export const MAX_RENDERED_CHARS = 5_000_000;
/** RFC 5322 line-length bound, same as `SendEmailInput.subject`. */
export const MAX_SUBJECT_CHARS = 998;

/**
 * No C0 control character, and no DEL, may reach a MIME header — CR and LF are
 * merely the famous two. ESC is RFC 2047's charset-switching lead-in, and NUL
 * truncates the value in whatever C-string-based agent handles the message
 * downstream. Exported so the authored value in `api/emails.ts` and
 * `api/templates.ts` is judged by the very rule the renderer applies to the
 * rendered one, rather than by a second copy that can drift from it.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
export const NO_CONTROL_CHARS = /^[^\x00-\x1F\x7F]*$/;

const HTML_ENTITY: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
  "=": "&#61;",
};

/**
 * Escapes a value for element text or for an attribute value in any delimiter
 * style.
 *
 * The five obvious characters are not enough. `<a href={{u}}>` is unquoted, and
 * unquoted attributes are ordinary in hand-written email HTML; there a value of
 * `x onmouseover=alert(1)` becomes a real event handler without using a single
 * quote character, and backtick delimiters do the same. Escaping the backtick
 * and `=` is OWASP's answer for that context, and `=` is the one that actually
 * closes it: attribute *names* are not entity-decoded, so `onmouseover&#61;…`
 * parses as one inert attribute name rather than as a handler.
 *
 * The cost is accepted knowingly — a literal `=` in visible text is emitted as
 * `&#61;`, which decodes back to `=` in text and in attribute values alike.
 */
export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"'`=]/g, (c) => HTML_ENTITY[c] as string);

/** Every placeholder name in `source`, deduplicated, in first-seen order. */
export function placeholderNames(source: string): string[] {
  const seen: string[] = [];
  for (const m of source.matchAll(placeholder())) {
    const name = m[1] as string;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/**
 * Occurrences, not distinct names: the cost of a render is one substitution per
 * occurrence, so `{{a}}` a thousand times is exactly the case the cap exists
 * for and deduplicating first would let it through.
 */
export const placeholderCount = (source: string): number =>
  source.match(placeholder())?.length ?? 0;

/** What a stored template supplies. `bodyText` is optional in the API and in the table. */
export interface TemplateSource {
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
}

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string | null;
}

/*
 * Only the fields the renderer reads; the full schema lives in
 * `api/templates.ts`. There is deliberately no `required` flag: a `default`
 * and the rule that every placeholder must resolve already express
 * optionality between them, and a third way to say it would end up meaning
 * "substitute nothing here", which is the behaviour Decision 2 refuses.
 */
export interface RenderVariableSpec {
  name: string;
  type?: "string" | "number" | "boolean";
  default?: string | number | boolean;
}
export interface RenderVariablesSchema {
  variables: RenderVariableSpec[];
}

export type RenderTemplateResult =
  | { ok: true; data: RenderedTemplate }
  | {
      ok: false;
      error: string;
      /** Placeholders with no value and no default. */
      missing: string[];
      /** Placeholders whose value is not a renderable scalar, or is the wrong declared type. */
      invalid: string[];
    };

const fail = (
  error: string,
  missing: string[] = [],
  invalid: string[] = [],
): RenderTemplateResult => ({ ok: false, error, missing, invalid });

/** `{}`-literal objects only: a prototype-chain hit is not data the caller passed. */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Walks a dotted path through own enumerable properties only, so
 * `{{a.constructor}}` and `{{a.__proto__.x}}` resolve to nothing rather than
 * to a function or to something an attacker planted up the chain.
 */
function lookup(values: Record<string, unknown>, path: string): unknown {
  let node: unknown = values;
  for (const key of path.split(".")) {
    if (!isPlainObject(node)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

type Resolved =
  { kind: "value"; text: string } | { kind: "missing" } | { kind: "invalid" };

/**
 * `undefined`, `null` and a string that is empty or all whitespace all mean
 * *no value*, and all fall back to a declared default.
 *
 * The refusal exists so that nobody mails "Hi ," to a list, and a supplied `""`
 * produces precisely that while sailing past an `undefined` check. It is also
 * the common case rather than the exotic one: a blank CSV cell is `""`, not
 * `undefined`. `null` is the natural wire encoding of "no value" and what a
 * nullable column serialises to, so it takes the default too. A caller who
 * genuinely wants an empty substitution declares `default: ""`, which is
 * honoured verbatim — the fallback is applied once and never re-examined.
 */
const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

function resolve(value: unknown, declared?: RenderVariableSpec): Resolved {
  if (value === undefined || value === null) return { kind: "missing" };
  if (typeof value === "number") {
    // NaN and Infinity are arithmetic accidents, not values worth emailing.
    if (!Number.isFinite(value)) return { kind: "missing" };
    if (declared?.type && declared.type !== "number")
      return { kind: "invalid" };
    return { kind: "value", text: String(value) };
  }
  if (typeof value === "boolean") {
    if (declared?.type && declared.type !== "boolean")
      return { kind: "invalid" };
    return { kind: "value", text: value ? "true" : "false" };
  }
  if (typeof value === "string") {
    if (declared?.type && declared.type !== "string")
      return { kind: "invalid" };
    return { kind: "value", text: value };
  }
  // Objects, arrays, functions, symbols, bigints: `[object Object]` in a
  // customer's inbox is a bug, and JSON-stringifying user data into HTML is a
  // larger escaping surface than this renderer wants.
  return { kind: "invalid" };
}

function resolveName(
  values: Record<string, unknown>,
  name: string,
  declared?: RenderVariableSpec,
): Resolved {
  let raw: unknown;
  try {
    raw = lookup(values, name);
  } catch {
    // A throwing getter, a Proxy trap, a lazy ORM accessor. This function's
    // contract is a `Result` and never an exception, and a value that cannot
    // be read is certainly not a renderable scalar.
    return { kind: "invalid" };
  }
  return resolve(isBlank(raw) ? declared?.default : raw, declared);
}

/**
 * Renders one field, abandoning it the moment the output passes `limit`.
 *
 * Substituted text is **never re-scanned**: the pattern walks `source` alone
 * and the output is only ever appended to, so a value containing `{{x}}` emits
 * the literal `{{x}}` and no input can make the renderer expand exponentially.
 * Appending also means no `$&`-style replacement pattern is ever interpreted.
 *
 * The size limit is applied as the string is built rather than to the finished
 * string, because the dashboard imports this function directly and so does not
 * pass through the payload caps in `api/templates.ts`: 500 occurrences of a
 * 200 KB value builds ~200 MB, and seconds of blocked CPU, before a trailing
 * check would fire. Returns `null` when the field exceeds `limit`.
 */
function renderField(
  source: string,
  resolved: Map<string, Resolved>,
  escape: boolean,
  missing: Set<string>,
  invalid: Set<string>,
  limit: number,
): string | null {
  let out = "";
  let cut = 0;
  for (const m of source.matchAll(placeholder())) {
    out += source.slice(cut, m.index);
    cut = m.index + m[0].length;
    const name = m[1] as string;
    const r = resolved.get(name) ?? { kind: "missing" as const };
    if (r.kind === "missing") missing.add(name);
    else if (r.kind === "invalid") invalid.add(name);
    else out += escape ? escapeHtml(r.text) : r.text;
    if (out.length > limit) return null;
  }
  out += source.slice(cut);
  return out.length > limit ? null : out;
}

/**
 * Renders a template's three fields together.
 *
 * Every placeholder must resolve: a missing value is a refusal naming it, not
 * an empty string, because "Hi ," at volume is discovered by a customer rather
 * than by us. Declare the variable with a `default` in `variables_schema` to
 * make it genuinely optional.
 */
export function renderTemplate(
  template: TemplateSource,
  variables: Record<string, unknown> = {},
  schema?: RenderVariablesSchema | null,
): RenderTemplateResult {
  // Defensive rather than decorative: callers build a `TemplateSource` from a
  // database row, where a nullable column and a `?? undefined` produce exactly
  // the shapes the type says cannot occur. Throwing a `TypeError` out of a
  // function whose contract is a `Result` is the worse failure.
  const bodyText = template.bodyText ?? null;
  if (
    typeof template.subject !== "string" ||
    typeof template.bodyHtml !== "string" ||
    (bodyText !== null && typeof bodyText !== "string")
  )
    return fail("The template subject and body must be text.");

  const fields = [template.subject, template.bodyHtml, bodyText];
  for (const field of fields)
    if (field && placeholderCount(field) > MAX_PLACEHOLDERS)
      return fail(
        `A template field may use at most ${MAX_PLACEHOLDERS} variables.`,
      );

  const declared = new Map<string, RenderVariableSpec>();
  for (const v of schema?.variables ?? []) declared.set(v.name, v);

  /*
   * Every distinct name is resolved exactly once, up front, before a single
   * field is built.
   *
   * Reading a value per *occurrence* would let a hostile accessor return one
   * thing while `subject` renders and another while `bodyHtml` renders, inside
   * one call — the preview/send divergence this module exists to make
   * impossible, arriving through the back door. Resolving once also means a
   * throwing getter is caught in one place, and the repeated lookups go away.
   */
  const resolved = new Map<string, Resolved>();
  for (const field of fields)
    if (field !== null)
      for (const name of placeholderNames(field))
        if (!resolved.has(name))
          resolved.set(name, resolveName(variables, name, declared.get(name)));

  const missing = new Set<string>();
  const invalid = new Set<string>();
  const render = (s: string, escape: boolean) =>
    renderField(s, resolved, escape, missing, invalid, MAX_RENDERED_CHARS);

  const subject = render(template.subject, false);
  const html = render(template.bodyHtml, true);
  // `""` stands in for "no text body" so the overflow check below narrows all
  // three at once; the real `null` is put back on the way out.
  const text = bodyText === null ? "" : render(bodyText, false);

  if (missing.size || invalid.size) {
    const parts: string[] = [];
    if (missing.size) parts.push(`missing: ${[...missing].join(", ")}`);
    if (invalid.size)
      parts.push(`not a string, number or boolean: ${[...invalid].join(", ")}`);
    return fail(
      `Template variables ${parts.join("; ")}.`,
      [...missing],
      [...invalid],
    );
  }

  if (subject === null || html === null || text === null)
    return fail("The rendered body is too large.");

  // The rendered subject, not the authored one, is what reaches the MIME
  // header — so it is checked here and nowhere else can catch it. The check
  // runs on the untrimmed string: `trim()` would quietly swallow a trailing
  // CRLF, which is exactly the shape a header injection takes.
  const trimmedSubject = subject.trim();
  if (!NO_CONTROL_CHARS.test(subject))
    return fail(
      "The rendered subject must not contain line breaks or control characters.",
    );
  if (trimmedSubject.length === 0)
    return fail("The rendered subject is empty.");
  if (trimmedSubject.length > MAX_SUBJECT_CHARS)
    return fail(
      `The rendered subject must be at most ${MAX_SUBJECT_CHARS} characters.`,
    );

  return {
    ok: true,
    data: {
      subject: trimmedSubject,
      html,
      text: bodyText === null ? null : text,
    },
  };
}
