import { z } from "zod";
import {
  MAX_PLACEHOLDERS,
  MAX_SUBJECT_CHARS,
  NO_CONTROL_CHARS,
  placeholderCount,
} from "../template";

/**
 * Contracts for `/api/v1/templates` (spec §7). Shared with the SDK and the
 * OpenAPI generator, so every schema here must stay
 * `z.toJSONSchema`-representable: `.refine`/`.superRefine` are fine (the
 * emitter ignores them) and `.trim()`/`.toLowerCase()` are `overwrite` checks
 * that keep the string type; a `.transform()` is not.
 */

/** URL key of a template: lower-case, digits and single dashes. */
export const TEMPLATE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Longest slug the API accepts; `slugifyTemplateName` truncates to it. */
export const MAX_SLUG_CHARS = 64;

export const TemplateSlug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Slug is required.")
  .max(MAX_SLUG_CHARS, "Slug is too long.")
  .regex(TEMPLATE_SLUG_RE, "Use lower-case letters, digits and dashes.");

/**
 * Best-effort name → slug for the dashboard's "new template" form. May return
 * "" (a name with no ASCII alphanumerics has no slug to offer); anything it
 * does return parses as a `TemplateSlug`, including for an over-long name —
 * truncation is re-trimmed so it cannot end on the dash it just cut.
 */
export const slugifyTemplateName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/, "");

export const TEMPLATE_VARIABLE_TYPES = ["string", "number", "boolean"] as const;
export type TemplateVariableType = (typeof TEMPLATE_VARIABLE_TYPES)[number];

/** Must match what the renderer's placeholder pattern can address. */
const VARIABLE_NAME = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/,
    "Use letters, digits and underscores, optionally dotted.",
  );

/*
 * Bounds on a *supplied* `variables` payload.
 *
 * The renderer checks `MAX_RENDERED_CHARS` after it has built the output, so
 * on its own it is a poor memory bound: a field may contain
 * `MAX_PLACEHOLDERS` (500) occurrences, and one large value repeated across
 * all of them is allocated in full before the refusal fires. Uncapped, the
 * ceiling is the route's body cap multiplied by 500. These three caps close
 * that at parse time, before a single substitution happens; the renderer's own
 * limit stays as the second line of defence.
 *
 * Why these numbers:
 *
 *   - 2 000 characters per value is roughly 300 words — a paragraph, an
 *     address block, an order summary line. It is deliberately the same bound
 *     `TemplateVariable.default` puts on a declared default, so a supplied
 *     value and the default it overrides are measured by one ruler. It is also
 *     the cap that actually bounds the amplification: 500 occurrences × 2 000
 *     characters is 1M characters per field, and ~6M for `bodyHtml` in the
 *     worst case where every character escapes to a 6-character entity. That
 *     peak is transient, comparable to the 10 MB of attachments a single send
 *     may already carry, and the renderer refuses immediately after. A value
 *     that genuinely needs to be larger is per-recipient content, which is
 *     what the `html` field is for.
 *   - 200 keys (counting nested objects and array items) sits comfortably
 *     above the 100 variables `TemplateVariablesSchema` lets a template
 *     declare — a nested payload needs more nodes than it has leaves — while
 *     keeping the walk below, and the render itself, small and finite.
 *   - 64 KB serialised bounds the payload as a whole, which neither of the
 *     other two does: 200 keys × 2 000 characters would otherwise be 400 KB of
 *     variables attached to every send.
 *
 * No real templated email comes close to any of the three.
 */

/** Keys allowed in a `variables` payload, counting nested objects and array items. */
export const MAX_VARIABLE_KEYS = 200;
/** Characters allowed in one variable value (and in one declared default). */
export const MAX_VARIABLE_VALUE_CHARS = 2_000;
/** Characters allowed in the whole `variables` payload once serialised. */
export const MAX_VARIABLES_JSON_CHARS = 64 * 1024;

interface VariablesProblem {
  message: string;
  path: (string | number)[];
}

const tooManyKeys: VariablesProblem = {
  message: `Variables may contain at most ${MAX_VARIABLE_KEYS} keys, counting nested objects and array items.`,
  path: [],
};

/**
 * The first cap `value` exceeds, or `null`. Iterative rather than recursive on
 * purpose: the payload is attacker-shaped, and a few thousand levels of
 * nesting must be a `validation_error` rather than a stack overflow thrown out
 * of `.parse()`.
 */
function variablesProblem(value: unknown): VariablesProblem | null {
  let keys = 0;
  const stack: { node: unknown; path: (string | number)[] }[] = [
    { node: value, path: [] },
  ];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (typeof node === "string") {
      if (node.length > MAX_VARIABLE_VALUE_CHARS)
        return {
          message: `A variable value may be at most ${MAX_VARIABLE_VALUE_CHARS} characters; this one is ${node.length}. Send longer per-recipient content as html.`,
          path,
        };
      continue;
    }
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        if (++keys > MAX_VARIABLE_KEYS) return tooManyKeys;
        stack.push({ node: node[i], path: [...path, i] });
      }
      continue;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        if (++keys > MAX_VARIABLE_KEYS) return tooManyKeys;
        stack.push({ node: child, path: [...path, key] });
      }
    }
  }

  // Serialised last: the walk above already bounds the work, and this is the
  // only check that has to touch the whole payload at once. A value JSON
  // cannot express (a bigint, a cycle) is a refusal rather than a throw —
  // every route here serialises what it stores.
  let serialised: string;
  try {
    serialised = JSON.stringify(value);
  } catch {
    return {
      message: "Variables must be JSON-serialisable.",
      path: [],
    };
  }
  if (serialised.length > MAX_VARIABLES_JSON_CHARS)
    return {
      message: `Variables may be at most ${MAX_VARIABLES_JSON_CHARS} characters once serialised; this payload is ${serialised.length}.`,
      path: [],
    };
  return null;
}

/**
 * The values a caller supplies for a render or a send — free-form by design
 * (the renderer decides what is substitutable), but bounded on three axes so a
 * request cannot make the renderer allocate far past its own output limit.
 * Distinct from `TemplateVariablesSchema`, which *declares* what a template
 * expects.
 */
export const TemplateVariablesPayload = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    const problem = variablesProblem(value);
    if (problem)
      ctx.addIssue({
        code: "custom",
        message: problem.message,
        path: problem.path,
      });
  });
export type TemplateVariablesPayload = z.infer<typeof TemplateVariablesPayload>;

/**
 * One declared variable.
 *
 * `default` is the only supported way to make a placeholder optional — the
 * renderer refuses a missing value outright — and it is what the editor shows
 * as the sample value in the live preview. There is deliberately no
 * `required` flag beside it: a flag would be a *third* way to express
 * optionality, layered on `default` and on the renderer's
 * every-placeholder-must-resolve rule, and the only thing `required: false`
 * could mean is a placeholder that renders as nothing — which is exactly what
 * Decision 2 refused. An unknown `required` key sent by an older client is
 * stripped, not rejected.
 */
export const TemplateVariable = z.object({
  name: VARIABLE_NAME,
  type: z.enum(TEMPLATE_VARIABLE_TYPES).default("string"),
  default: z
    .union([z.string().max(MAX_VARIABLE_VALUE_CHARS), z.number(), z.boolean()])
    .optional(),
  description: z.string().trim().max(200).optional(),
});
export type TemplateVariable = z.infer<typeof TemplateVariable>;

/**
 * The declared shape of a template's variables.
 *
 * The two cross-entry rules are here rather than left to render time on
 * purpose: both mistakes are made while authoring, and both surface at render
 * as something that blames the wrong party. A duplicate name silently
 * last-wins, so the editor shows a `default` or a `description` that the
 * renderer never uses; and a `default` that contradicts its own declared
 * `type` is reported by `renderTemplate` as `not a string, number or boolean`
 * against a variable the caller never supplied — a schema mistake charged to
 * the send.
 */
export const TemplateVariablesSchema = z
  .object({
    variables: z.array(TemplateVariable).max(100).default([]),
  })
  .superRefine(({ variables }, ctx) => {
    const seen = new Set<string>();
    variables.forEach((v, i) => {
      if (seen.has(v.name))
        ctx.addIssue({
          code: "custom",
          message: `The variable "${v.name}" is declared more than once.`,
          path: ["variables", i, "name"],
        });
      seen.add(v.name);
      if (v.default !== undefined && typeof v.default !== v.type)
        ctx.addIssue({
          code: "custom",
          message: `The default for "${v.name}" is a ${typeof v.default}, but the variable is declared as ${v.type}.`,
          path: ["variables", i, "default"],
        });
    });
  });
export type TemplateVariablesSchema = z.infer<typeof TemplateVariablesSchema>;

// The renderer's rule, imported rather than restated, so the authored subject
// and the rendered one cannot be judged by two rules that drift apart. Covers
// every C0 control and DEL, not only CR/LF.
const subject = z
  .string()
  .trim()
  .min(1, "Subject is required.")
  .max(MAX_SUBJECT_CHARS)
  .regex(
    NO_CONTROL_CHARS,
    "Subject must not contain line breaks or control characters.",
  );

/** 5 MB, the same bound `SendEmailInput` puts on `html`/`text`. */
const body = z.string().max(5_000_000);

/**
 * A field may not use more placeholders than the renderer will substitute.
 *
 * Uses the renderer's own counter: occurrences, not distinct names (`{{a}}` a
 * thousand times is exactly the case the cap exists for), counted by the one
 * pattern that will do the substituting — so a template the API accepts is a
 * template the renderer accepts, with no second copy of the grammar to drift.
 */
const withinPlaceholderLimit = (s: string | undefined) =>
  s === undefined || placeholderCount(s) <= MAX_PLACEHOLDERS;

const PLACEHOLDER_LIMIT_MESSAGE = `A template field may use at most ${MAX_PLACEHOLDERS} variables (counting every occurrence).`;

export const CreateTemplateInput = z
  .object({
    slug: TemplateSlug,
    name: z.string().trim().min(1, "Name is required.").max(120),
    subject,
    bodyHtml: body.min(1, "An HTML body is required."),
    bodyText: body.optional(),
    variablesSchema: TemplateVariablesSchema.default({ variables: [] }),
  })
  .refine(
    (t) =>
      withinPlaceholderLimit(t.subject) &&
      withinPlaceholderLimit(t.bodyHtml) &&
      withinPlaceholderLimit(t.bodyText),
    { message: PLACEHOLDER_LIMIT_MESSAGE },
  );
export type CreateTemplateInput = z.infer<typeof CreateTemplateInput>;

/**
 * Every field optional, at least one present. `slug` is deliberately absent:
 * renaming the key of a template that a live `POST /emails` names by slug is a
 * silent outage, so a rename is a create plus a delete.
 */
export const UpdateTemplateInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    subject,
    bodyHtml: body.min(1),
    bodyText: body.nullable(),
    variablesSchema: TemplateVariablesSchema,
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "Nothing to update.")
  .refine(
    (t) =>
      withinPlaceholderLimit(t.subject) &&
      withinPlaceholderLimit(t.bodyHtml) &&
      withinPlaceholderLimit(t.bodyText ?? undefined),
    { message: PLACEHOLDER_LIMIT_MESSAGE },
  );
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateInput>;

export const TemplateObject = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  subject: z.string(),
  bodyHtml: z.string(),
  bodyText: z.string().nullable(),
  variablesSchema: TemplateVariablesSchema,
  /** Bumped on every content change; `template_versions` holds each one. */
  version: z.number().int(),
  updatedBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TemplateObject = z.infer<typeof TemplateObject>;

/** One entry of the version history. `snapshot` is the template as it was at that version. */
export const TemplateVersionObject = z.object({
  version: z.number().int(),
  snapshot: z.object({
    name: z.string(),
    subject: z.string(),
    bodyHtml: z.string(),
    bodyText: z.string().nullable(),
    variablesSchema: TemplateVariablesSchema,
  }),
  createdBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type TemplateVersionObject = z.infer<typeof TemplateVersionObject>;

/** `POST /templates/:slug/render` — a dry run, nothing is sent or stored. */
export const RenderTemplateInput = z.object({
  variables: TemplateVariablesPayload.default({}),
});
export type RenderTemplateInput = z.infer<typeof RenderTemplateInput>;

export const RenderedTemplateObject = z.object({
  subject: z.string(),
  html: z.string(),
  text: z.string().nullable(),
});
export type RenderedTemplateObject = z.infer<typeof RenderedTemplateObject>;
