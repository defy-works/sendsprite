import {
  placeholderNames,
  renderTemplate,
  type RenderTemplateResult,
  type TemplateVariable,
  type TemplateVariablesSchema,
  type TemplateVariableType,
} from "@sendsprite/shared";

/**
 * The pure half of the template editor: what the form holds, what it declares,
 * and what the live preview renders.
 *
 * It is a module rather than hooks inside the component for two reasons. The
 * preview is the one part of this page with a correctness property worth
 * testing — it must produce what a send produces — and a `.tsx` client
 * component is not something this repo's vitest setup can mount. And the
 * mapping from "the text an input holds" to "the value the contract stores"
 * (a number-typed default, an empty description) has to be written once, not
 * once for the preview and again for the save.
 *
 * Nothing here renders anything itself: `previewTemplate` assembles the same
 * three arguments `renderTemplateRow` in `services/templates.ts` assembles
 * from a stored row, and hands them to the same `renderTemplate`. That is the
 * whole reason the renderer is pure and lives in `@sendsprite/shared` — a
 * second implementation in a component would be a preview that can lie.
 */

/** One row of the editor's variable table: every field is the text an input holds. */
export interface VariableRow {
  name: string;
  type: TemplateVariableType;
  /** Always a string here; coerced to the declared type on the way out. */
  default: string;
  description: string;
}

/** The fields of the template the editor is editing. */
export interface DraftFields {
  subject: string;
  bodyHtml: string;
  /** `""` means "no text body" — the column is nullable and the API omits it. */
  bodyText: string;
  variables: VariableRow[];
}

export const emptyVariableRow = (name = ""): VariableRow => ({
  name,
  type: "string",
  default: "",
  description: "",
});

/** The editor rows for a stored `variables_schema`. */
export const variableRowsOf = (
  schema: TemplateVariablesSchema,
): VariableRow[] =>
  schema.variables.map((v) => ({
    name: v.name,
    type: v.type,
    default: v.default === undefined ? "" : String(v.default),
    description: v.description ?? "",
  }));

/** `bodyText` as the row stores it: an empty textarea is no text body, not an empty one. */
export const bodyTextOf = (d: DraftFields): string | null =>
  d.bodyText.trim() ? d.bodyText : null;

/** Every placeholder the three fields use, deduplicated and sorted. */
export const usedPlaceholders = (d: DraftFields): string[] =>
  [
    ...new Set([
      ...placeholderNames(d.subject),
      ...placeholderNames(d.bodyHtml),
      ...placeholderNames(d.bodyText),
    ]),
  ].sort();

/** The declared names, ignoring the blank row an "Add variable" click leaves. */
export const declaredNames = (d: DraftFields): string[] =>
  d.variables.map((v) => v.name.trim()).filter((n) => n !== "");

/**
 * Placeholders the body uses that the schema does not declare.
 *
 * This is the part of "variable autocomplete" with real value: an undeclared
 * placeholder has no default, so every send that omits it is refused. Saying
 * so while the template is being written is cheaper than a 400 in production.
 */
export function undeclaredPlaceholders(d: DraftFields): string[] {
  const declared = new Set(declaredNames(d));
  return usedPlaceholders(d).filter((n) => !declared.has(n));
}

/**
 * The text of a `default` input as the declared type.
 *
 * A value that does not parse as its type is deliberately left as text rather
 * than coerced to `NaN` or to `false`: `TemplateVariablesSchema` then refuses
 * the save naming the variable ("the default for x is a string, but the
 * variable is declared as number"), which is the truth, where `NaN` would be
 * stored as a JSON `null` and surface much later as a missing variable.
 */
function declaredDefault(
  row: VariableRow,
): string | number | boolean | undefined {
  if (row.default === "") return undefined;
  if (row.type === "number") {
    const n = Number(row.default);
    return row.default.trim() !== "" && Number.isFinite(n) ? n : row.default;
  }
  if (row.type === "boolean") {
    const t = row.default.trim().toLowerCase();
    return t === "true" ? true : t === "false" ? false : row.default;
  }
  return row.default;
}

/** The `variables_schema` this draft would be saved with. */
export function variablesSchemaOf(d: DraftFields): TemplateVariablesSchema {
  const variables: TemplateVariable[] = [];
  for (const row of d.variables) {
    const name = row.name.trim();
    if (!name) continue; // the blank row "Add variable" leaves is not a variable
    const variable: TemplateVariable = { name, type: row.type };
    const value = declaredDefault(row);
    if (value !== undefined) variable.default = value;
    const description = row.description.trim();
    if (description) variable.description = description;
    variables.push(variable);
  }
  return { variables };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Writes `value` at a dotted path, and gives up rather than overwriting
 * anything already there.
 *
 * `{{user}}` and `{{user.name}}` in one template cannot both be satisfied by
 * one payload — a value is either a scalar or an object — so the second one
 * is left unset and the preview reports it as missing. That is exactly what a
 * send would do with the same two placeholders, which is the point.
 */
function assignPath(
  root: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let node = root;
  for (const key of path.slice(0, -1)) {
    const child = node[key];
    if (child === undefined) {
      const next: Record<string, unknown> = {};
      node[key] = next;
      node = next;
      continue;
    }
    if (!isRecord(child)) return; // blocked by a scalar a shorter name claimed
    node = child;
  }
  const leaf = path[path.length - 1];
  if (leaf !== undefined && node[leaf] === undefined) node[leaf] = value;
}

/** A visible stand-in for a variable the author has not given a default. */
const sampleFor = (name: string, type: TemplateVariableType): unknown =>
  type === "number" ? 0 : type === "boolean" ? true : `{${name}}`;

/**
 * The variables the preview renders with.
 *
 * A placeholder with a declared default is left out entirely so the renderer
 * applies that default itself, by the same code path a send takes; everything
 * else gets a stand-in of its declared type, `{name}` for a string, so the
 * author can see where the value lands. Dotted names are nested, because the
 * renderer walks `a.b` through the object and a flat `"a.b"` key would resolve
 * to nothing.
 */
export function previewValues(
  used: string[],
  schema: TemplateVariablesSchema,
): Record<string, unknown> {
  const declared = new Map(schema.variables.map((v) => [v.name, v]));
  const values: Record<string, unknown> = {};
  for (const name of used) {
    const spec = declared.get(name);
    if (spec?.default !== undefined) continue; // the renderer applies it
    assignPath(
      values,
      name.split("."),
      sampleFor(name, spec?.type ?? "string"),
    );
  }
  return values;
}

/**
 * Renders the draft exactly as `renderTemplateRow` renders a stored row: the
 * same three fields, the same declared schema, the same `renderTemplate`.
 *
 * The one difference is the variables, which are stand-ins rather than a
 * caller's payload — and being generated from the schema they are bounded by
 * it, so unlike `renderTemplateRow` there is nothing here for
 * `TemplateVariablesPayload` to defend against.
 */
export function previewTemplate(d: DraftFields): RenderTemplateResult {
  const schema = variablesSchemaOf(d);
  return renderTemplate(
    { subject: d.subject, bodyHtml: d.bodyHtml, bodyText: bodyTextOf(d) },
    previewValues(usedPlaceholders(d), schema),
    schema,
  );
}
