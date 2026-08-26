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
 *   - `subject` does not, but the **rendered** result is re-checked for CR/LF,
 *     because `SendEmailInput`'s no-line-breaks rule only sees what the client
 *     sent and a rendered subject bypasses it by construction. That check is
 *     the header-injection guard.
 */

/** Placeholder: `{{ name }}` or `{{ a.b.c }}`, whitespace tolerated. */
const PLACEHOLDER =
  /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3})\s*\}\}/g;

/** Placeholders allowed in one field. A template is authored, not generated. */
export const MAX_PLACEHOLDERS = 500;
/** Matches the `html`/`text` bound in `SendEmailInput`, so a render cannot produce an unstorable body. */
export const MAX_RENDERED_CHARS = 5_000_000;
/** RFC 5322 line-length bound, same as `SendEmailInput.subject`. */
export const MAX_SUBJECT_CHARS = 998;

const HTML_ENTITY: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** The five characters that can break out of HTML text or an attribute value. */
export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => HTML_ENTITY[c] as string);

/** Every placeholder name in `source`, deduplicated, in first-seen order. */
export function placeholderNames(source: string): string[] {
  const seen: string[] = [];
  for (const m of source.matchAll(PLACEHOLDER)) {
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
const placeholderCount = (source: string): number =>
  source.match(PLACEHOLDER)?.length ?? 0;

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

/** Only the fields the renderer reads; the full schema lives in `api/templates.ts`. */
export interface RenderVariableSpec {
  name: string;
  type?: "string" | "number" | "boolean";
  required?: boolean;
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

/**
 * Renders one field. Substituted text is **never re-scanned** — `replace` with
 * a function walks the source once — so a value containing `{{x}}` emits the
 * literal `{{x}}` and no input can make the renderer expand exponentially.
 */
function renderField(
  source: string,
  values: Record<string, unknown>,
  declared: Map<string, RenderVariableSpec>,
  escape: boolean,
  missing: Set<string>,
  invalid: Set<string>,
): string {
  return source.replace(PLACEHOLDER, (_match, rawName: string) => {
    const name = rawName;
    const spec = declared.get(name);
    const raw = lookup(values, name);
    const r = resolve(raw === undefined ? spec?.default : raw, spec);
    if (r.kind === "missing") {
      missing.add(name);
      return "";
    }
    if (r.kind === "invalid") {
      invalid.add(name);
      return "";
    }
    return escape ? escapeHtml(r.text) : r.text;
  });
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
  for (const field of [template.subject, template.bodyHtml, template.bodyText])
    if (field && placeholderCount(field) > MAX_PLACEHOLDERS)
      return fail(
        `A template field may use at most ${MAX_PLACEHOLDERS} variables.`,
      );

  const declared = new Map<string, RenderVariableSpec>();
  for (const v of schema?.variables ?? []) declared.set(v.name, v);

  const missing = new Set<string>();
  const invalid = new Set<string>();
  const render = (s: string, escape: boolean) =>
    renderField(s, variables, declared, escape, missing, invalid);

  const subject = render(template.subject, false);
  const html = render(template.bodyHtml, true);
  const text =
    template.bodyText === null ? null : render(template.bodyText, false);

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

  // The rendered subject, not the authored one, is what reaches the MIME
  // header — so it is checked here and nowhere else can catch it. The test is
  // on the untrimmed string: `trim()` would quietly swallow a trailing CRLF,
  // which is exactly the shape a header injection takes.
  const trimmedSubject = subject.trim();
  if (/[\r\n]/.test(subject))
    return fail("The rendered subject must not contain line breaks.");
  if (trimmedSubject.length === 0)
    return fail("The rendered subject is empty.");
  if (trimmedSubject.length > MAX_SUBJECT_CHARS)
    return fail(
      `The rendered subject must be at most ${MAX_SUBJECT_CHARS} characters.`,
    );
  if (
    html.length > MAX_RENDERED_CHARS ||
    (text?.length ?? 0) > MAX_RENDERED_CHARS
  )
    return fail("The rendered body is too large.");

  return { ok: true, data: { subject: trimmedSubject, html, text } };
}
