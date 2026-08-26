"use client";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  TEMPLATE_VARIABLE_TYPES,
  renderBlocks,
  slugifyTemplateName,
  type CampaignBlock,
  type CampaignTheme,
  type TemplateVariableType,
} from "@sendsprite/shared";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmailPreview } from "@/components/ui/EmailPreview";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { IconEye, IconSend } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { BlockDesigner } from "@/components/editor/BlockDesigner";
import { TestSendDialog } from "@/components/app/TestSendDialog";
import { blockDefaults } from "@/lib/editor/blocks";
import {
  blocksOfTree,
  editorLeaf,
  editorNodesOf,
  type EditorNode,
} from "@/lib/editor/tree";
import {
  createTemplate,
  restoreVersion,
  sendTemplateTestAction,
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
  /** The visual editor's tree, when this template is authored that way. */
  nodes: EditorNode[] | null;
  /** `{}` is "the renderer's defaults". Only meaningful in design mode. */
  theme: CampaignTheme;
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
  nodes: null,
  theme: {},
};

/** The three fields a variable chip can be inserted into. */
type TextField = "subject" | "bodyHtml" | "bodyText";

/** A `<select>` hands back a string; narrow it rather than assert it. */
const variableTypeOf = (value: string): TemplateVariableType =>
  TEMPLATE_VARIABLE_TYPES.find((k) => k === value) ?? "string";

/**
 * Two ways to author a body, and the template knows which one it is.
 *
 * `design` on the row is the block tree; null means the body was written as
 * HTML. That is not a display preference — it decides what a save writes, so
 * it is stored rather than remembered per browser, and switching is an
 * explicit, confirmed action rather than a tab.
 */
type Mode = "design" | "html";

export function TemplateEditor({
  mode,
  template = STARTER,
  version,
  versions = [],
  canManage,
  userEmail,
  sesSandbox,
  domains,
}: {
  mode: "create" | "edit";
  template?: EditorTemplate;
  /** The live version number, for the header badge. Absent while creating. */
  version?: number;
  versions?: VersionRow[];
  canManage: boolean;
  userEmail: string;
  sesSandbox: boolean;
  /** Verified domains, for the From address of a test send. */
  domains: { id: string; name: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [t, setT] = useState(template);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [testFrom, setTestFrom] = useState(
    domains[0] ? `hello@${domains[0].name}` : "",
  );
  /** The last state written to the database, as a string, so edits are detectable. */
  const [committed, setCommitted] = useState(() =>
    JSON.stringify(serialisable(template)),
  );
  const subjectRef = useRef<HTMLInputElement>(null);
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const focused = useRef<TextField>("bodyHtml");

  const dirty = JSON.stringify(serialisable(t)) !== committed;
  const authoring: Mode = t.nodes === null ? "html" : "design";
  const readOnly = !canManage;

  const set = <K extends keyof EditorTemplate>(k: K, v: EditorTemplate[K]) =>
    setT((prev) => ({ ...prev, [k]: v }));
  const setVariables = (rows: VariableRow[]) => set("variables", rows);
  const editVariable = (i: number, patch: Partial<VariableRow>) =>
    setVariables(t.variables.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const setNodes = useCallback(
    (fn: (nodes: EditorNode[]) => EditorNode[]) =>
      setT((prev) =>
        prev.nodes === null ? prev : { ...prev, nodes: fn(prev.nodes) },
      ),
    [],
  );

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

  /**
   * In design mode the HTML is derived, not typed.
   *
   * Compiled here for the preview and the placeholder scan, and compiled
   * *again* by the service on save — from the blocks, not from this string —
   * so what is stored cannot drift from what the blocks say. This copy is a
   * display value; the service's is the one that counts.
   */
  const compiled = useMemo(() => {
    if (t.nodes === null) return null;
    try {
      const { html, text } = renderBlocks(blocksOfTree(t.nodes), {
        unsubscribe: false,
        theme: t.theme,
      });
      return { ok: true as const, html, text };
    } catch (e) {
      return {
        ok: false as const,
        error:
          e instanceof Error ? e.message : "This design cannot be rendered.",
      };
    }
  }, [t.nodes, t.theme]);

  /** What the placeholder scan and the preview read, whichever mode this is. */
  const effective: DraftFields = useMemo(
    () => ({
      subject: t.subject,
      bodyHtml: compiled?.ok ? compiled.html : t.bodyHtml,
      bodyText: compiled?.ok ? (compiled.text ?? "") : t.bodyText,
      variables: t.variables,
    }),
    [t.subject, t.bodyHtml, t.bodyText, t.variables, compiled],
  );

  const used = useMemo(() => usedPlaceholders(effective), [effective]);
  const undeclared = useMemo(
    () => undeclaredPlaceholders(effective),
    [effective],
  );
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
  const preview = useMemo(() => previewTemplate(effective), [effective]);

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
    // `null` clears a stored design, which is what HTML mode means. Never
    // `undefined`: the service reads that as "leave it alone", and a template
    // switched to HTML would keep compiling from blocks nobody can see.
    design: state.nodes === null ? null : blocksOfTree(state.nodes),
    // Cleared with the design: a theme on an HTML-authored template would
    // never be applied to anything, because the body is no longer compiled.
    theme: state.nodes === null ? null : state.theme,
  });

  /**
   * Switching how the body is authored.
   *
   * Design → HTML keeps the compiled markup, so nothing is lost and the author
   * can carry on from it; the blocks go, because a design that no longer
   * produces the stored HTML would overwrite the next hand edit.
   *
   * HTML → design cannot parse arbitrary HTML into blocks — that is a whole
   * different product — so it starts a new body and says so before it does.
   */
  const switchMode = async (next: Mode) => {
    if (next === authoring) return;
    if (next === "html") {
      const ok = await confirm({
        title: "Edit this template as HTML?",
        body: "The blocks are replaced by the HTML they currently produce, and the visual editor is switched off for this template. Switching back later starts a new design from scratch.",
        confirmLabel: "Switch to HTML",
      });
      if (!ok) return;
      setT((prev) => ({
        ...prev,
        bodyHtml: compiled?.ok ? compiled.html : prev.bodyHtml,
        bodyText: compiled?.ok ? (compiled.text ?? "") : prev.bodyText,
        nodes: null,
      }));
      return;
    }
    const ok = await confirm({
      title: "Build this template visually?",
      body: "HTML cannot be turned back into blocks, so this starts a new body. Your current HTML is replaced the moment you save.",
      confirmLabel: "Start a design",
      tone: "danger",
    });
    if (!ok) return;
    setT((prev) => ({
      ...prev,
      nodes: [
        editorLeaf(blockDefaults("heading")),
        editorLeaf(blockDefaults("text")),
      ],
      theme: {},
    }));
  };

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
        setCommitted(JSON.stringify(serialisable(state)));
        toast({ tone: "success", title: "Template saved" });
        router.refresh(); // the version history and the badge move
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  const restore = async (v: VersionRow) => {
    const ok = await confirm({
      title: `Restore v${v.version}?`,
      body: dirty
        ? "Your unsaved changes are discarded. The restore is saved as a new version, so the restore itself can be undone."
        : "It is saved as a new version rather than rewinding, so this can be undone.",
      confirmLabel: `Restore v${v.version}`,
    });
    if (!ok) return;
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
          nodes: res.data.design ? editorNodesOf(res.data.design) : null,
          theme: res.data.theme ?? {},
        };
        setT(next);
        setCommitted(JSON.stringify(serialisable(next)));
        toast({ tone: "success", title: `Restored v${v.version}` });
        router.refresh();
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  const variablesCard = (
    <Card>
      <CardHeader>
        <CardTitle>Variables</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {insertable.length === 0 ? (
          <p className="text-sm text-white/60">
            Write <code>{"{{name}}"}</code> in the subject or a body to add one.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {insertable.map((n) => (
              <Button
                key={n}
                size="sm"
                variant="subtle"
                disabled={readOnly || authoring === "design"}
                onClick={() => insert(n)}
                title={
                  authoring === "design"
                    ? "In the visual editor, type the placeholder straight into a block."
                    : "Insert at the cursor of the last field you were typing in"
                }
              >
                {`{{${n}}}`}
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
            <Field
              id={`var-name-${i}`}
              label="Name"
              className="min-w-36 flex-1"
            >
              <Input
                id={`var-name-${i}`}
                value={v.name}
                disabled={readOnly}
                onChange={(e) => editVariable(i, { name: e.target.value })}
              />
            </Field>
            <Field id={`var-type-${i}`} label="Type" className="w-28">
              <Select
                id={`var-type-${i}`}
                value={v.type}
                disabled={readOnly}
                onChange={(value) =>
                  editVariable(i, { type: variableTypeOf(value) })
                }
                options={TEMPLATE_VARIABLE_TYPES.map((k) => ({
                  value: k,
                  label: k,
                }))}
              />
            </Field>
            <Field
              id={`var-default-${i}`}
              label="Default"
              className="min-w-36 flex-1"
            >
              <Input
                id={`var-default-${i}`}
                value={v.default}
                placeholder="none — the variable is required"
                disabled={readOnly}
                onChange={(e) => editVariable(i, { default: e.target.value })}
              />
            </Field>
            <Field
              id={`var-desc-${i}`}
              label="Description"
              className="min-w-36 flex-1"
            >
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
            </Field>
            <Button
              size="sm"
              variant="subtle"
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
            variant="subtle"
            disabled={readOnly}
            onClick={() => setVariables([...t.variables, emptyVariableRow()])}
          >
            Add variable
          </Button>
          {undeclared.length > 0 && (
            <Button
              size="sm"
              variant="subtle"
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
          A missing value is a refused send, never an empty string — a default
          is what makes a variable optional.
        </p>
      </CardBody>
    </Card>
  );

  const detailsCard = (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
        {!readOnly && (
          <SegmentedControl
            value={authoring}
            options={[
              { value: "design", label: "Design" },
              { value: "html", label: "HTML" },
            ]}
            onChange={(v) => void switchMode(v)}
          />
        )}
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="tpl-name" label="Name">
            <Input
              id="tpl-name"
              value={t.name}
              disabled={readOnly}
              maxLength={120}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          {mode === "create" ? (
            <Field
              id="tpl-slug"
              label="Slug"
              hint="The name you pass as template when sending. Derived from the name if left blank, and it cannot be changed later — renaming is a new template plus a delete."
            >
              <Input
                id="tpl-slug"
                value={t.slug}
                placeholder={slugifyTemplateName(t.name) || "welcome"}
                disabled={readOnly}
                onChange={(e) => set("slug", e.target.value)}
              />
            </Field>
          ) : (
            <Field id="tpl-slug-ro" label="Slug">
              <Input id="tpl-slug-ro" value={t.slug} readOnly disabled />
            </Field>
          )}
        </div>
        <Field id="tpl-subject" label="Subject">
          <Input
            id="tpl-subject"
            ref={subjectRef}
            value={t.subject}
            disabled={readOnly}
            onFocus={() => (focused.current = "subject")}
            onChange={(e) => set("subject", e.target.value)}
          />
        </Field>
      </CardBody>
    </Card>
  );

  const previewCard = (
    <Card className="xl:sticky xl:top-20 xl:self-start">
      <CardHeader>
        <CardTitle>Preview</CardTitle>
        <IconEye className="text-white/30" />
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {compiled && !compiled.ok && <Alert>{compiled.error}</Alert>}
        {preview.ok ? (
          <>
            <p className="text-sm break-words text-white/65">
              <span className="text-white/40">Subject </span>
              {preview.data.subject}
            </p>
            <EmailPreview
              title="Template preview"
              html={preview.data.html}
              // A template body is a fragment, not a document: it paints no
              // background of its own, and without a wrapper the frame would
              // inherit the dashboard's dark colour-scheme.
              wrap={authoring === "html"}
              height="28rem"
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
          <Alert>{preview.error}</Alert>
        )}
        <p className="text-xs text-white/50">
          Variables with a default show it; the rest show{" "}
          <code>{"{name}"}</code>.
        </p>
      </CardBody>
    </Card>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: "/app/templates", label: "Templates" }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {mode === "create" ? "New template" : t.name || t.slug}
            {mode === "edit" && version !== undefined && (
              <Badge variant="muted">v{version}</Badge>
            )}
            {dirty && !readOnly && (
              <Badge variant="warning">Unsaved changes</Badge>
            )}
          </span>
        }
        actions={
          canManage ? (
            <>
              {mode === "edit" && (
                <Button
                  variant="subtle"
                  icon={<IconSend />}
                  disabled={dirty || domains.length === 0}
                  title={
                    domains.length === 0
                      ? "Verify a sending domain first."
                      : dirty
                        ? "Save first — a test renders the stored template."
                        : undefined
                  }
                  onClick={() => setTestOpen(true)}
                >
                  Send a test
                </Button>
              )}
              <Button
                loading={pending}
                disabled={mode === "edit" && !dirty}
                onClick={save}
              >
                {mode === "create" ? "Create" : "Save"}
              </Button>
            </>
          ) : (
            <span className="text-sm text-white/60">
              Read-only — editing templates needs the admin role.
            </span>
          )
        }
      />

      {error && <Alert>{error}</Alert>}

      {authoring === "design" && t.nodes !== null ? (
        <BlockDesigner
          nodes={t.nodes}
          onChange={setNodes}
          theme={t.theme}
          onThemeChange={(theme) => set("theme", theme)}
          readOnly={readOnly}
          bodyTitle="Body"
          settings={
            <div className="flex flex-col gap-6">
              {detailsCard}
              {variablesCard}
            </div>
          }
          preview={previewCard}
        />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="flex min-w-0 flex-col gap-6">
            {detailsCard}
            <Card>
              <CardHeader>
                <CardTitle>Body</CardTitle>
              </CardHeader>
              <CardBody className="flex flex-col gap-4">
                <Field id="tpl-html" label="HTML body">
                  <Textarea
                    id="tpl-html"
                    ref={htmlRef}
                    rows={16}
                    className="font-mono text-xs"
                    value={t.bodyHtml}
                    disabled={readOnly}
                    onFocus={() => (focused.current = "bodyHtml")}
                    onChange={(e) => set("bodyHtml", e.target.value)}
                  />
                </Field>
                <Field
                  id="tpl-text"
                  label="Plain-text body (optional)"
                  hint="Values are HTML-escaped in the HTML body and left alone here. Leave it empty to send no text part."
                >
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
                </Field>
              </CardBody>
            </Card>
            {variablesCard}
          </div>
          {previewCard}
        </div>
      )}

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
                      variant="subtle"
                      disabled={pending}
                      onClick={() => void restore(v)}
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

      <TestSendDialog
        open={testOpen}
        onDismiss={() => setTestOpen(false)}
        defaultTo={userEmail}
        sandbox={sesSandbox}
        onSend={(to) =>
          sendTemplateTestAction(t.slug, {
            to,
            from: testFrom,
            // Declared defaults, so the test renders without the caller having
            // to type a value for every variable. One without a default shows
            // as its own name, which is what the preview does too.
            variables: Object.fromEntries(
              t.variables
                .filter((v) => v.name.trim())
                .map((v) => [
                  v.name.trim(),
                  v.default.trim() || `{${v.name.trim()}}`,
                ]),
            ),
          })
        }
      >
        <Field
          id="test-from"
          label="From"
          hint="Any address at one of your verified domains."
        >
          <Input
            id="test-from"
            value={testFrom}
            onChange={(e) => setTestFrom(e.target.value)}
          />
        </Field>
        <p className="text-sm text-white/65">
          Rendered from the <strong>saved</strong> template, with each
          variable&apos;s declared default.
        </p>
      </TestSendDialog>
    </div>
  );
}

/**
 * The template minus its editor ids, for the dirty check.
 *
 * The block ids change whenever a block is added, including when a drag is
 * cancelled and the tree ends up identical, so comparing them would call that
 * an edit.
 */
function serialisable(t: EditorTemplate) {
  return {
    slug: t.slug,
    name: t.name,
    subject: t.subject,
    bodyHtml: t.bodyHtml,
    bodyText: t.bodyText,
    variables: t.variables,
    design:
      t.nodes === null ? null : (blocksOfTree(t.nodes) as CampaignBlock[]),
    theme: t.nodes === null ? null : t.theme,
  };
}
