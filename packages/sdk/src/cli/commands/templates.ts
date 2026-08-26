import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Sendsprite } from "../../index";
import type {
  CreateTemplateInput,
  TemplateObject,
  TemplateVariablesSchema,
  UpdateTemplateInput,
} from "../../types";
import type { CommandContext } from "../index";
import { message } from "../output";

/**
 * `sendsprite templates pull|push <dir>` — templates as files in a repo.
 *
 * Three files per template, named by the slug, so a diff shows HTML as HTML
 * rather than one enormous escaped JSON string:
 *
 *   <slug>.json   { name, subject, variablesSchema }
 *   <slug>.html   the bodyHtml
 *   <slug>.txt    the bodyText, when there is one
 *
 * The slug is the identity — it is immutable server-side, and it is already
 * constrained to lower-case letters, digits and dashes, which is a legal file
 * name everywhere — so the file name can carry it and no manifest field has to
 * repeat it. The presence or absence of `<slug>.txt` is how `bodyText: null` is
 * represented, without a `null` literal in the manifest.
 *
 * **This module must not import `@sendsprite/shared`**: `tests/dist.test.ts`
 * forbids that specifier in the published `cli.js`. Hence the local copy of the
 * slug rule below rather than a reuse of `TemplateSlug`.
 */

/** Mirrors `TEMPLATE_SLUG_RE` / `MAX_SLUG_CHARS` in the shared contract. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_CHARS = 64;

const MANIFEST_KEYS = ["name", "subject", "variablesSchema"] as const;

/** `<slug>.json`. Everything about a template that is not a body. */
interface Manifest {
  name: string;
  subject: string;
  variablesSchema?: TemplateVariablesSchema;
}

/** One local template, read and validated but not yet compared. */
interface Local {
  slug: string;
  manifest: Manifest;
  bodyHtml: string;
  /** `undefined` when there is no `<slug>.txt` — see `patchFor`. */
  bodyText: string | undefined;
}

/** What `push` decided to do, before anything is sent. */
type Action =
  | { verb: "create"; slug: string; input: CreateTemplateInput }
  | { verb: "update"; slug: string; patch: UpdateTemplateInput }
  | { verb: "unchanged"; slug: string };

export function registerTemplates({
  program,
  client,
  write,
  writeError,
  run,
}: CommandContext) {
  const templates = program
    .command("templates")
    .description("Templates as files in a directory")
    .exitOverride();

  templates
    .command("pull")
    .argument("<dir>", "Directory to write into (created if absent)")
    .description("Write every template in the team to <dir>")
    .option("--dry-run", "Report what would be written and write nothing")
    .action(
      run(async (dir: string, opts: { dryRun?: boolean }) => {
        const remote = await listAll(client());
        if (!opts.dryRun) mkdirSync(dir, { recursive: true });
        let changed = 0;
        for (const t of remote) {
          // The slug becomes three file names. A server that answered
          // "../../etc/passwd" must not get to write there.
          if (!SLUG_RE.test(t.slug)) {
            throw new Error(
              `Refusing to write a template with an unexpected slug: ${JSON.stringify(t.slug)}.`,
            );
          }
          // `null` content means "this file must not exist", which is how a
          // template with no text body is represented on disk.
          const wanted: readonly (readonly [string, string | null])[] = [
            [`${t.slug}.json`, manifestText(t)],
            [`${t.slug}.html`, t.bodyHtml],
            [`${t.slug}.txt`, t.bodyText],
          ];
          const ops = wanted.map(([name, content]) => {
            const path = join(dir, name);
            return { path, content, now: read(path) };
          });
          if (ops.every((op) => op.now === op.content)) {
            write(`unchanged ${t.slug}`);
            continue;
          }
          changed += 1;
          write(`${opts.dryRun ? "would write" : "wrote"} ${t.slug}`);
          if (opts.dryRun) continue;
          for (const op of ops) {
            if (op.now === op.content) continue;
            // A `.txt` left over from before the text body was removed would
            // be pushed straight back as a text body on the next `push`.
            if (op.content === null) rmSync(op.path);
            else writeFileSync(op.path, op.content);
          }
        }
        const known = new Set(remote.map((t) => t.slug));
        const local = manifestsIn(entriesOf(dir) ?? []).filter(
          (f) => !known.has(basename(f)),
        );
        if (local.length > 0) {
          // Unpushed work, not drift: reported, never removed.
          writeError(
            `note: not on the instance and left alone: ${local.map(basename).join(", ")} — \`templates push\` creates them.`,
          );
        }
        write(
          `${count(remote.length)}, ${changed} ${opts.dryRun ? "would change" : "changed"}`,
        );
      }),
    );

  templates
    .command("push")
    .argument("<dir>", "Directory holding <slug>.json / .html / .txt")
    .description(
      "Create or update every template found in <dir>. Never deletes.",
    )
    .option("--dry-run", "Report what would change and send nothing")
    .action(
      run(async (dir: string, opts: { dryRun?: boolean }) => {
        // Everything is read and validated before anything is sent: a
        // directory with one broken file must not leave half of it pushed.
        const locals = readDirectory(dir, writeError);
        const api = client();
        const remote = new Map(
          (await listAll(api)).map((t) => [t.slug, t] as const),
        );
        const actions = locals.map((local) => {
          const current = remote.get(local.slug);
          if (current === undefined) {
            return {
              verb: "create",
              slug: local.slug,
              input: createInputFor(local),
            } satisfies Action;
          }
          if (local.bodyText === undefined && current.bodyText !== null) {
            writeError(
              `note: ${local.slug} has a text body on the instance but there is no ${local.slug}.txt here; push left it alone.`,
            );
          }
          const patch = patchFor(local, current);
          const fields = Object.keys(patch);
          return fields.length === 0
            ? ({ verb: "unchanged", slug: local.slug } satisfies Action)
            : ({ verb: "update", slug: local.slug, patch } satisfies Action);
        });

        // `push` has no delete path at all; saying so is what makes the
        // absence of a file obviously not a deletion.
        const untouched = [...remote.keys()].filter(
          (slug) => !locals.some((l) => l.slug === slug),
        );
        if (untouched.length > 0) {
          writeError(
            `note: ${count(untouched.length)} on the instance have no file here and were left alone (push never deletes): ${untouched.join(", ")}`,
          );
        }

        for (const action of actions) {
          if (action.verb === "unchanged") {
            write(`unchanged ${action.slug}`);
            continue;
          }
          const fields =
            action.verb === "update"
              ? ` (${Object.keys(action.patch).join(", ")})`
              : "";
          if (opts.dryRun) {
            write(`would ${action.verb} ${action.slug}${fields}`);
            continue;
          }
          if (action.verb === "create")
            await api.templates.create(action.input);
          else await api.templates.update(action.slug, action.patch);
          write(`${action.verb}d ${action.slug}${fields}`);
        }
        const changed = actions.filter((a) => a.verb !== "unchanged").length;
        write(
          `${count(actions.length)}, ${changed} ${opts.dryRun ? "would change" : "changed"}`,
        );
      }),
    );
}

/** Every template in the team, oldest page first. */
async function listAll(api: Sendsprite): Promise<TemplateObject[]> {
  const all: TemplateObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.templates.list(
      cursor === undefined ? { limit: 100 } : { limit: 100, cursor },
    );
    all.push(...page.data);
    // An empty page with a cursor would otherwise spin forever.
    cursor = page.data.length > 0 ? (page.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return all;
}

const manifestText = (t: TemplateObject): string =>
  `${JSON.stringify(
    {
      name: t.name,
      subject: t.subject,
      variablesSchema: t.variablesSchema,
    } satisfies Manifest,
    null,
    2,
  )}\n`;

/** File contents, or `null` when there is no such file. */
function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const basename = (file: string): string => file.slice(0, -".json".length);

const count = (n: number): string => `${n} template${n === 1 ? "" : "s"}`;

/** Sorted so the output does not depend on the filesystem's ordering. */
const entriesOf = (dir: string): string[] | null => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return null;
  }
};

const manifestsIn = (entries: string[]): string[] =>
  entries.filter((f) => f.endsWith(".json"));

/**
 * Reads and validates every template in `dir`. Throws on the first problem,
 * naming the file and what is wrong with it, because a partial push is worse
 * than no push.
 */
function readDirectory(dir: string, writeError: (line: string) => void) {
  const entries = entriesOf(dir);
  if (entries === null) {
    throw new Error(
      `Cannot read the template directory ${dir}. Run \`sendsprite templates pull ${dir}\` first, or point at a directory of <slug>.json / .html / .txt files.`,
    );
  }
  const manifests = manifestsIn(entries);
  const slugs = new Set(manifests.map(basename));
  const strays = entries
    .filter((f) => f.endsWith(".html") || f.endsWith(".txt"))
    .filter((f) => !slugs.has(f.replace(/\.(html|txt)$/, "")));
  if (strays.length > 0) {
    // Almost always a mistyped file name. Not fatal — the directory may hold
    // other things — but silence would hide the typo.
    writeError(`note: ignored (no matching .json): ${strays.join(", ")}`);
  }
  return manifests.map((file) => readTemplate(dir, file));
}

function readTemplate(dir: string, file: string): Local {
  const slug = basename(file);
  if (!SLUG_RE.test(slug) || slug.length > MAX_SLUG_CHARS) {
    throw new Error(
      `${file}: ${JSON.stringify(slug)} is not a usable template slug — use lower-case letters, digits and single dashes, at most ${MAX_SLUG_CHARS} characters.`,
    );
  }
  let parsed: unknown;
  const raw = readFileSync(join(dir, file), "utf8");
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${file}: not valid JSON — ${message(cause)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${file}: expected a JSON object with "name" and "subject".`,
    );
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if ((MANIFEST_KEYS as readonly string[]).includes(key)) continue;
    // Catches the obvious mistake of pasting the bodies into the manifest.
    throw new Error(
      `${file}: unexpected key ${JSON.stringify(key)} — a manifest holds only ${MANIFEST_KEYS.join(", ")}; the bodies live in ${slug}.html and ${slug}.txt.`,
    );
  }
  for (const key of ["name", "subject"] as const) {
    if (typeof record[key] !== "string" || record[key].trim() === "") {
      throw new Error(`${file}: "${key}" is required and must be a string.`);
    }
  }
  const schema = record.variablesSchema;
  if (
    schema !== undefined &&
    (typeof schema !== "object" || schema === null || Array.isArray(schema))
  ) {
    throw new Error(
      `${file}: "variablesSchema" must be an object like { "variables": [] }.`,
    );
  }
  const htmlPath = join(dir, `${slug}.html`);
  const bodyHtml = read(htmlPath);
  if (bodyHtml === null) {
    throw new Error(
      `${file}: no matching ${slug}.html — every template needs an HTML body.`,
    );
  }
  const textPath = join(dir, `${slug}.txt`);
  return {
    slug,
    manifest: {
      name: record.name as string,
      subject: record.subject as string,
      ...(schema === undefined
        ? {}
        : { variablesSchema: schema as TemplateVariablesSchema }),
    },
    bodyHtml,
    bodyText: existsSync(textPath) ? readFileSync(textPath, "utf8") : undefined,
  };
}

const createInputFor = (local: Local): CreateTemplateInput => ({
  slug: local.slug,
  name: local.manifest.name,
  subject: local.manifest.subject,
  bodyHtml: local.bodyHtml,
  ...(local.bodyText === undefined ? {} : { bodyText: local.bodyText }),
  ...(local.manifest.variablesSchema === undefined
    ? {}
    : { variablesSchema: local.manifest.variablesSchema }),
});

/**
 * The fields that actually differ, and nothing else.
 *
 * Comparison is byte-for-byte on the values `pull` wrote, so a round trip with
 * no edit produces an empty patch and no request at all — the server cuts a
 * version on any content change, and a re-upload of identical bytes would be a
 * version row nobody asked for. Erring is one-directional on purpose: an
 * unexpected difference (JSON key order, say) yields a patch the server may
 * still treat as a no-op, whereas claiming "unchanged" when something did move
 * would silently drop the operator's edit.
 *
 * A missing `<slug>.txt` sends no `bodyText` at all rather than `null`: an
 * absent file is ambiguous (never pulled? gitignored? lost?), and push must not
 * be able to delete content it cannot see.
 */
function patchFor(local: Local, current: TemplateObject): UpdateTemplateInput {
  const patch: UpdateTemplateInput = {};
  if (local.manifest.name !== current.name) patch.name = local.manifest.name;
  if (local.manifest.subject !== current.subject) {
    patch.subject = local.manifest.subject;
  }
  if (local.bodyHtml !== current.bodyHtml) patch.bodyHtml = local.bodyHtml;
  if (local.bodyText !== undefined && local.bodyText !== current.bodyText) {
    patch.bodyText = local.bodyText;
  }
  const schema = local.manifest.variablesSchema;
  if (
    schema !== undefined &&
    JSON.stringify(schema) !== JSON.stringify(current.variablesSchema)
  ) {
    patch.variablesSchema = schema;
  }
  return patch;
}
