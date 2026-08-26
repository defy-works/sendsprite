"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  TEMPLATE_VARIABLE_TYPES,
  slugifyTemplateName,
  type TemplateVariableType,
} from "@sendsprite/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Link } from "@/components/ui/Link";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import {
  createTemplate,
  restoreVersion,
  updateTemplate,
  type Result,
  type TemplateDraft,
} from "../actions";
import {
  emptyVariableRow,
  previewTemplate,
  undeclaredPlaceholders,
  usedPlaceholders,
  variablesSchemaOf,
  variableRowsOf,
  type DraftFields,
  type VariableRow,
} from "../preview";

export interface VersionRow {
  version: number;
  created: string;
}

/** Everything the form holds. `slug` is only editable while creating. */
export interface EditorTemplate extends DraftFields {
  slug: string;
  name: string;
}

/**
 * A starter rather than a blank page: the preview is the thing worth seeing
 * first, and it has nothing to show until a placeholder exists.
 */
const STARTER: EditorTemplate = {
  slug: "",
  name: "",
  subject: "Hello {{name}}",
  bodyHtml: "<p>Hello {{name}},</p>\n",
  bodyText: "",
  variables: [],
};

/** The three fields a variable chip can be inserted into. */
type TextField = "subject" | "bodyHtml" | "bodyText";

/** A `<select>` hands back a string; narrow it rather than assert it. */
const variableTypeOf = (value: string): TemplateVariableType =>
  TEMPLATE_VARIABLE_TYPES.find((k) => k === value) ?? "string";

export function TemplateEditor({
  mode,
  template = STARTER,
  version,
  versions = [],
  canManage,
}: {
  mode: "create" | "edit";
  template?: EditorTemplate;
  /** The live version number, for the header badge. Absent while creating. */
  version?: number;
  versions?: VersionRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [t, setT] = useState(template);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /** The last state written to the database, as a string, so edits are detectable. */
  const [committed, setCommitted] = useState(() => JSON.stringify(template));
  const subjectRef = useRef<HTMLInputElement>(null);
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const focused = useRef<TextField>("bodyHtml");

  const dirty = JSON.stringify(t) !== committed;

  const set = <K extends keyof EditorTemplate>(k: K, v: EditorTemplate[K]) => {
    setSaved(false);
    setT((prev) => ({ ...prev, [k]: v }));
  };
  const setVariables = (rows: VariableRow[]) => set("variables", rows);
  const editVariable = (i: number, patch: Partial<VariableRow>) =>
    setVariables(t.variables.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  /**
   * A body is minutes of work and a tab close is one keystroke. This catches a
   * reload or a close; an in-app navigation is React's to intercept and is not
   * worth a router hook here.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const used = useMemo(() => usedPlaceholders(t), [t]);
  const undeclared = useMemo(() => undeclaredPlaceholders(t), [t]);
  /** Chips for everything declared, plus anything the body uses but has not declared. */
  const insertable = useMemo(
    () =>
      [
        ...new Set([
          ...t.variables.map((v) => v.name.trim()).filter(Boolean),
          ...used,
        ]),
      ].sort(),
    [t.variables, used],
  );

  /**
   * The live preview runs the **same** `renderTemplate` the send path runs,
   * with the same declared schema — see `preview.ts`. What is shown here
   * cannot differ from what a send produces for the same variables.
   */
  const preview = useMemo(() => previewTemplate(t), [t]);

  const elementOf = (
    field: TextField,
  ): HTMLInputElement | HTMLTextAreaElement | null =>
    field === "subject"
      ? subjectRef.current
      : field === "bodyHtml"
        ? htmlRef.current
        : textRef.current;

  /** Writes `{{name}}` at the cursor of whichever field was last focused. */
  const insert = (name: string) => {
    const field = focused.current;
    const token = `{{${name}}}`;
    const value = t[field];
    const el = elementOf(field);
    if (!el) return set(field, value + token);
    const at = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? at;
    set(field, value.slice(0, at) + token + value.slice(end));
    // After React has written the new value, put the caret after the token.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const draftOf = (state: EditorTemplate): TemplateDraft => ({
    ...(mode === "create"
      ? { slug: state.slug.trim() || slugifyTemplateName(state.name) }
      : {}),
    name: state.name,
    subject: state.subject,
    bodyHtml: state.bodyHtml,
    bodyText: state.bodyText,
    variablesSchema: variablesSchemaOf(state),
  });

  const save = () => {
    const state = t; // the values being saved, not whatever is typed meanwhile
    start(async () => {
      setError(null);
      try {
        if (mode === "create") {
          const res = await createTemplate(draftOf(state));
          if (!res.ok) return setError(res.error);
          router.push(`/app/templates/${res.data.slug}`);
          return;
        }
        const res: Result = await updateTemplate(state.slug, draftOf(state));
        if (!res.ok) return setError(res.error);
        setCommitted(JSON.stringify(state));
        setSaved(true);
        router.refresh(); // the version history and the badge move
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  const restore = (v: VersionRow) => {
    if (
      !window.confirm(
        dirty
          ? `Restore v${v.version}? Your unsaved changes are discarded, and the restore is saved as a new version.`
          : `Restore v${v.version}? It is saved as a new version, so this can be undone.`,
      )
    )
      return;
    start(async () => {
      setError(null);
      try {
        const res = await restoreVersion(t.slug, v.version);
        if (!res.ok) return setError(res.error);
        // Adopt what the restore actually wrote; a `router.refresh()` alone
        // re-renders the server page but cannot reach into this state.
        const next: EditorTemplate = {
          ...t,
          name: res.data.name,
          subject: res.data.subject,
          bodyHtml: res.data.bodyHtml,
          bodyText: res.data.bodyText ?? "",
          variables: variableRowsOf(res.data.variablesSchema),
        };
        setT(next);
        setCommitted(JSON.stringify(next));
        setSaved(true);
        router.refresh();
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  const readOnly = !canManage;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Link href="/app/templates" className="num-stamp no-underline">
            ← Templates
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-medium">
              {mode === "create" ? "New template" : t.name || t.slug}
            </h1>
            {mode === "edit" && (
              <>
                <code className="text-xs text-white/50">{t.slug}</code>
                {version !== undefined && (
                  <Badge variant="muted">v{version}</Badge>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {dirty && <Badge variant="warning">Unsaved changes</Badge>}
          {saved && !dirty && (
            <span className="text-sm text-white/60">Saved.</span>
          )}
          {canManage ? (
            <Button
              disabled={pending || (mode === "edit" && !dirty)}
              onClick={save}
            >
              {pending ? "Saving…" : mode === "create" ? "Create" : "Save"}
            </Button>
          ) : (
            <span className="text-sm text-white/60">
              Read-only — editing templates needs the admin role.
            </span>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Content</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            <div>
              <Label htmlFor="tpl-name">Name</Label>
              <Input
                id="tpl-name"
                value={t.name}
                disabled={readOnly}
                maxLength={120}
                onChange={(e) => set("name", e.target.value)}
              />
            </div>
            {mode === "create" && (
              <div>
                <Label htmlFor="tpl-slug">Slug</Label>
                <Input
                  id="tpl-slug"
                  value={t.slug}
                  placeholder={slugifyTemplateName(t.name) || "welcome"}
                  disabled={readOnly}
                  onChange={(e) => set("slug", e.target.value)}
                />
                <p className="mt-1 text-xs text-white/50">
                  The name you pass as <code>template</code> when sending.
                  Derived from the name if you leave it blank, and it cannot be
                  changed later — renaming is a new template plus a delete.
                </p>
              </div>
            )}
            <div>
              <Label htmlFor="tpl-subject">Subject</Label>
              <Input
                id="tpl-subject"
                ref={subjectRef}
                value={t.subject}
                disabled={readOnly}
                onFocus={() => (focused.current = "subject")}
                onChange={(e) => set("subject", e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="tpl-html">HTML body</Label>
              <Textarea
                id="tpl-html"
                ref={htmlRef}
                rows={14}
                className="font-mono text-xs"
                value={t.bodyHtml}
                disabled={readOnly}
                onFocus={() => (focused.current = "bodyHtml")}
                onChange={(e) => set("bodyHtml", e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="tpl-text">Plain-text body (optional)</Label>
              <Textarea
                id="tpl-text"
                ref={textRef}
                rows={6}
                className="font-mono text-xs"
                value={t.bodyText}
                disabled={readOnly}
                onFocus={() => (focused.current = "bodyText")}
                onChange={(e) => set("bodyText", e.target.value)}
              />
              <p className="mt-1 text-xs text-white/50">
                Values are HTML-escaped in the HTML body and left alone here.
                Leave it empty to send no text part.
              </p>
            </div>
          </CardBody>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Variables</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              {insertable.length === 0 ? (
                <p className="text-sm text-white/60">
                  Write <code>{"{{name}}"}</code> in the subject or a body to
                  add one.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {insertable.map((n) => (
                    <Button
                      key={n}
                      size="sm"
                      variant="ghost"
                      disabled={readOnly}
                      onClick={() => insert(n)}
                      title="Insert at the cursor of the last field you were typing in"
                    >
                      {`Insert {{${n}}}`}
                    </Button>
                  ))}
                </div>
              )}

              {undeclared.length > 0 && (
                <p role="alert" className="text-sm text-amber-300">
                  Not declared below, so a send that omits{" "}
                  {undeclared.length === 1 ? "it" : "them"} is refused:{" "}
                  {undeclared.join(", ")}
                </p>
              )}

              {t.variables.map((v, i) => (
                <div
                  key={i}
                  className="flex flex-wrap items-end gap-2 border-t border-white/8 pt-3"
                >
                  <div className="min-w-40 flex-1">
                    <Label htmlFor={`var-name-${i}`}>Name</Label>
                    <Input
                      id={`var-name-${i}`}
                      value={v.name}
                      disabled={readOnly}
                      onChange={(e) =>
                        editVariable(i, { name: e.target.value })
                      }
                    />
                  </div>
                  <div className="w-28">
                    <Label htmlFor={`var-type-${i}`}>Type</Label>
                    <Select
                      id={`var-type-${i}`}
                      value={v.type}
                      disabled={readOnly}
                      onChange={(e) =>
                        editVariable(i, {
                          type: variableTypeOf(e.target.value),
                        })
                      }
                    >
                      {TEMPLATE_VARIABLE_TYPES.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="min-w-40 flex-1">
                    <Label htmlFor={`var-default-${i}`}>Default</Label>
                    <Input
                      id={`var-default-${i}`}
                      value={v.default}
                      placeholder="none — the variable is required"
                      disabled={readOnly}
                      onChange={(e) =>
                        editVariable(i, { default: e.target.value })
                      }
                    />
                  </div>
                  <div className="min-w-40 flex-1">
                    <Label htmlFor={`var-desc-${i}`}>Description</Label>
                    <Input
                      id={`var-desc-${i}`}
                      value={v.description}
                      placeholder="optional"
                      maxLength={200}
                      disabled={readOnly}
                      onChange={(e) =>
                        editVariable(i, { description: e.target.value })
                      }
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={readOnly}
                    onClick={() =>
                      setVariables(t.variables.filter((_, j) => j !== i))
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={readOnly}
                  onClick={() =>
                    setVariables([...t.variables, emptyVariableRow()])
                  }
                >
                  Add variable
                </Button>
                {undeclared.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={readOnly}
                    onClick={() =>
                      setVariables([
                        ...t.variables,
                        ...undeclared.map((n) => emptyVariableRow(n)),
                      ])
                    }
                  >
                    Declare the {undeclared.length} missing
                  </Button>
                )}
              </div>
              <p className="text-xs text-white/50">
                A missing value is a refused send, never an empty string — a
                default is what makes a variable optional.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Preview</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              {preview.ok ? (
                <>
                  <p className="text-sm break-words text-white/65">
                    <span className="text-white/40">Subject </span>
                    {preview.data.subject}
                  </p>
                  {/* The same sandbox as the email detail view. Escaping stops
                      markup injection; the empty sandbox is what stops a
                      `javascript:` href or a CSS `url()` in a value from
                      running against this dashboard's own origin. */}
                  <iframe
                    title="Template preview"
                    sandbox=""
                    srcDoc={preview.data.html}
                    className="h-96 w-full rounded-lg border border-white/10 bg-white"
                  />
                  {preview.data.text !== null && (
                    <details>
                      <summary className="cursor-pointer text-xs text-white/50">
                        Plain-text part
                      </summary>
                      <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-white/4 p-3 font-mono text-xs whitespace-pre-wrap text-white/75">
                        {preview.data.text}
                      </pre>
                    </details>
                  )}
                </>
              ) : (
                <p role="alert" className="text-sm text-red-300">
                  {preview.error}
                </p>
              )}
              <p className="text-xs text-white/50">
                Rendered by the same code the server uses, inside a sandboxed
                frame that runs nothing. Variables with a default show it; the
                rest show <code>{"{name}"}</code>.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>

      {mode === "edit" && versions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Version history</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="flex flex-col gap-2 text-sm">
              {versions.map((v, i) => (
                <li key={v.version} className="flex items-center gap-3">
                  <Badge variant={i === 0 ? "indigo" : "muted"}>
                    v{v.version}
                  </Badge>
                  <span className="text-white/65">{v.created}</span>
                  {i === 0 && <span className="text-white/40">live</span>}
                  {i > 0 && canManage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => restore(v)}
                    >
                      Restore
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-white/50">
              A version is cut when the content changes, not on every save.
              Restoring appends a new version rather than rewinding, so the
              record of what was live and when stays complete — and a restore is
              itself undoable.
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
