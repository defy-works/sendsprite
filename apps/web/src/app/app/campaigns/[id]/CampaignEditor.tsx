"use client";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import type { CampaignStatus, CampaignTheme } from "@sendsprite/shared";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmailPreview } from "@/components/ui/EmailPreview";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { IconSend } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { BlockDesigner } from "@/components/editor/BlockDesigner";
import { TestSendDialog } from "@/components/app/TestSendDialog";
import { blocksOfTree, type EditorNode } from "@/lib/editor/tree";
import {
  createCampaign,
  sendCampaignTestAction,
  updateCampaign,
  type CampaignDraft,
  type Result,
} from "../actions";
import { previewCampaign } from "../preview";

export interface BookOption {
  id: string;
  name: string;
  contactCount: number;
}
export interface DomainOption {
  id: string;
  name: string;
}

/** Everything the form holds. `nodes` carry editor-local ids; see `tree.ts`. */
export interface EditorCampaign {
  name: string;
  bookId: string;
  domainId: string;
  from: string;
  /** `""` is "no reply-to"; the actions module translates it per path. */
  replyTo: string;
  subject: string;
  nodes: EditorNode[];
  /** `{}` is "the renderer's defaults", which is what a null column means. */
  theme: CampaignTheme;
}

const STATUS_VARIANT: Record<CampaignStatus, BadgeVariant> = {
  draft: "muted",
  scheduled: "indigo",
  sending: "warning",
  sent: "success",
  cancelled: "danger",
};

/**
 * Why a campaign in this status cannot be edited, or `null` if it can.
 *
 * The truth lives in `EDITABLE_STATUSES` in `services/campaigns/crud.ts`,
 * which a client component cannot import — it reaches the database. This is a
 * **full** `Record`, so a status added later fails the typecheck here rather
 * than defaulting to editable, which is the direction that matters: the worst
 * outcome is a form that accepts edits to a half-sent campaign and then errors
 * on save, having lost the author's work.
 *
 * The copy says what already happened rather than "not allowed", because that
 * is the actual reason: mail has gone out under this name, and editing the
 * body now would mean the first ten thousand recipients got one email and the
 * rest got another, under one set of stats.
 */
const LOCKED: Record<CampaignStatus, string | null> = {
  draft: null,
  scheduled: null,
  sending:
    "This campaign is sending. Its body is fixed for the whole send — the first and last recipient have to receive the same email — so nothing here can be changed. Cancel it to stop further fan-out.",
  sent: "This campaign has been sent. What went out cannot be changed after the fact; duplicate it to send something similar.",
  cancelled:
    "This campaign was cancelled part-way through sending, so some of its mail has already left. It is kept as a record and cannot be edited.",
};

const NO_PERMISSION =
  "Read-only — creating and editing campaigns needs the admin role.";

export function CampaignEditor({
  mode,
  campaignId,
  campaign,
  status = "draft",
  canManage,
  books,
  domains,
  userEmail,
  sesSandbox,
}: {
  mode: "create" | "edit";
  /** Absent while creating. */
  campaignId?: string;
  campaign: EditorCampaign;
  status?: CampaignStatus;
  canManage: boolean;
  books: BookOption[];
  /** Verified domains only — an unverified one would fail for every recipient. */
  domains: DomainOption[];
  userEmail: string;
  /** SES is still in the sandbox, so a test only reaches verified addresses. */
  sesSandbox: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [c, setC] = useState(campaign);
  const [liveStatus, setLiveStatus] = useState(status);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  /** The last state written to the database, as a string, so edits are detectable. */
  const [committed, setCommitted] = useState(() =>
    JSON.stringify(serialisable(campaign)),
  );

  const dirty = JSON.stringify(serialisable(c)) !== committed;
  const locked = mode === "edit" ? LOCKED[liveStatus] : null;
  const readOnly = !canManage || locked !== null;

  const set = <K extends keyof EditorCampaign>(k: K, v: EditorCampaign[K]) =>
    setC((prev) => ({ ...prev, [k]: v }));
  const setNodes = useCallback(
    (fn: (nodes: EditorNode[]) => EditorNode[]) =>
      setC((prev) => ({ ...prev, nodes: fn(prev.nodes) })),
    [],
  );

  /**
   * A campaign body is an hour of work and a tab close is one keystroke. The
   * same guard the template editor uses, and for the same reason: an in-app
   * navigation is React's to intercept, a reload is not.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /**
   * The live preview runs the **same** `renderBlocks` the send runs. There is
   * no React renderer for blocks anywhere in this app, deliberately — see
   * `preview.ts`.
   */
  const preview = useMemo(
    () => previewCampaign(blocksOfTree(c.nodes), c.theme),
    [c.nodes, c.theme],
  );

  const bookMissing = c.bookId !== "" && !books.some((b) => b.id === c.bookId);
  const domainMissing =
    c.domainId !== "" && !domains.some((d) => d.id === c.domainId);

  const draftOf = (state: EditorCampaign): CampaignDraft => ({
    name: state.name,
    bookId: state.bookId,
    domainId: state.domainId,
    from: state.from,
    replyTo: state.replyTo,
    subject: state.subject,
    blocks: blocksOfTree(state.nodes),
    theme: state.theme,
  });

  const save = () => {
    const state = c; // what is being saved, not whatever is typed meanwhile
    start(async () => {
      setError(null);
      try {
        if (mode === "create") {
          const res = await createCampaign(draftOf(state));
          if (!res.ok) return setError(res.error);
          router.push(`/app/campaigns/${res.data.id}`);
          return;
        }
        if (!campaignId) return;
        const res: Result<{ status: CampaignStatus }> = await updateCampaign(
          campaignId,
          draftOf(state),
        );
        if (!res.ok) return setError(res.error);
        setCommitted(JSON.stringify(serialisable(state)));
        toast({ tone: "success", title: "Campaign saved" });
        // An edit to a scheduled campaign reverts it to a draft and drops the
        // send time; the badge has to move with it.
        setLiveStatus(res.data.status);
        router.refresh();
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: "/app/campaigns", label: "Campaigns" }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {mode === "create" ? "New campaign" : c.name || "Untitled"}
            {mode === "edit" && (
              <Badge variant={STATUS_VARIANT[liveStatus]}>{liveStatus}</Badge>
            )}
            {dirty && !readOnly && (
              <Badge variant="warning">Unsaved changes</Badge>
            )}
          </span>
        }
        actions={
          readOnly ? (
            <span className="max-w-md text-right text-sm text-white/60">
              {locked ?? NO_PERMISSION}
            </span>
          ) : (
            <>
              <Button
                variant="subtle"
                icon={<IconSend />}
                onClick={() => setTestOpen(true)}
              >
                Send a test
              </Button>
              <Button
                loading={pending}
                disabled={mode === "edit" && !dirty}
                onClick={save}
              >
                {mode === "create" ? "Create" : "Save"}
              </Button>
            </>
          )
        }
      />

      {error && <Alert>{error}</Alert>}

      {liveStatus === "scheduled" && !readOnly && (
        <p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
          This campaign is scheduled. Saving an edit returns it to a draft and
          clears the send time, so nobody ships an unreviewed change on the old
          timer — reschedule it when you are done.
        </p>
      )}

      <BlockDesigner
        nodes={c.nodes}
        onChange={setNodes}
        theme={c.theme}
        onThemeChange={(theme) => set("theme", theme)}
        readOnly={readOnly}
        invalidIndex={preview.ok ? null : preview.index}
        settings={
          <Card>
            <CardHeader>
              <CardTitle>Settings</CardTitle>
            </CardHeader>
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <Field
                id="cmp-name"
                label="Name"
                hint="Internal only. Recipients never see it."
              >
                <Input
                  id="cmp-name"
                  value={c.name}
                  maxLength={200}
                  disabled={readOnly}
                  onChange={(e) => set("name", e.target.value)}
                />
              </Field>

              <Field id="cmp-subject" label="Subject">
                <Input
                  id="cmp-subject"
                  value={c.subject}
                  disabled={readOnly}
                  onChange={(e) => set("subject", e.target.value)}
                />
              </Field>

              <Field
                id="cmp-book"
                label="Contact book"
                error={
                  bookMissing
                    ? "The book this campaign was drawn from has been deleted. Pick another before saving."
                    : undefined
                }
                hint="Everyone in it who is subscribed and not suppressed — consent and deliverability are separate, and both have to say yes."
              >
                <Select
                  id="cmp-book"
                  value={c.bookId}
                  disabled={readOnly}
                  placeholder="Choose a book…"
                  onChange={(v) => set("bookId", v)}
                  options={[
                    /* A campaign outlives its book: `book_id` carries no
                       foreign key, so the stored id can point at nothing.
                       Kept as an option so the row still renders what it
                       says, with a warning telling the author to repoint it. */
                    ...(bookMissing
                      ? [
                          {
                            value: c.bookId,
                            label: "Deleted book",
                            hint: c.bookId,
                          },
                        ]
                      : []),
                    ...books.map((b) => ({
                      value: b.id,
                      label: b.name,
                      hint: `${b.contactCount.toLocaleString("en-US")} contacts`,
                    })),
                  ]}
                />
              </Field>

              <Field
                id="cmp-domain"
                label="Sending domain"
                error={
                  domainMissing
                    ? "This domain is gone or no longer verified. A campaign sent from it would fail for every recipient."
                    : undefined
                }
              >
                <Select
                  id="cmp-domain"
                  value={c.domainId}
                  disabled={readOnly}
                  placeholder="Choose a domain…"
                  onChange={(v) => set("domainId", v)}
                  options={[
                    ...(domainMissing
                      ? [
                          {
                            value: c.domainId,
                            label: "Deleted or unverified",
                            hint: c.domainId,
                          },
                        ]
                      : []),
                    ...domains.map((d) => ({ value: d.id, label: d.name })),
                  ]}
                />
              </Field>

              <Field
                id="cmp-from"
                label="From"
                hint="Must be an address at the domain above."
              >
                <Input
                  id="cmp-from"
                  value={c.from}
                  placeholder="hello@yourdomain.com"
                  disabled={readOnly}
                  onChange={(e) => set("from", e.target.value)}
                />
              </Field>

              <Field id="cmp-replyto" label="Reply-to (optional)">
                <Input
                  id="cmp-replyto"
                  value={c.replyTo}
                  placeholder="none"
                  disabled={readOnly}
                  onChange={(e) => set("replyTo", e.target.value)}
                />
              </Field>
            </CardBody>
          </Card>
        }
        preview={
          /* Contents, not a card: these share the body card with the canvas so
             the header and the mode switch stay put when the mode changes. */
          <>
            <p className="text-sm break-words text-white/65">
              <span className="text-white/40">Subject </span>
              {c.subject || <span className="text-white/40">(none)</span>}
            </p>
            {preview.ok ? (
              <>
                <EmailPreview title="Campaign preview" html={preview.html} />
                <details>
                  <summary className="cursor-pointer text-xs text-white/50">
                    Plain-text part
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-white/4 p-3 font-mono text-xs whitespace-pre-wrap text-white/75">
                    {preview.text}
                  </pre>
                </details>
              </>
            ) : (
              <Alert>{preview.error}</Alert>
            )}
            <p className="text-xs text-white/50">
              The unsubscribe footer is added per recipient.
            </p>
          </>
        }
      />

      <TestSendDialog
        open={testOpen}
        onDismiss={() => setTestOpen(false)}
        defaultTo={userEmail}
        sandbox={sesSandbox}
        onSend={(to) =>
          sendCampaignTestAction(
            {
              from: c.from,
              replyTo: c.replyTo,
              subject: c.subject,
              blocks: blocksOfTree(c.nodes),
              theme: c.theme,
            },
            to,
          )
        }
      >
        <p className="text-sm text-white/65">
          Sent from <strong>{c.from || "(no From address)"}</strong> with the
          body exactly as it is now — unsaved edits included.
        </p>
      </TestSendDialog>
    </div>
  );
}

/**
 * The campaign minus its editor ids, for the dirty check.
 *
 * Comparing the tree directly would compare ids, and an id changes whenever a
 * block is added — including when a drag is cancelled and the tree ends up
 * identical. Stripping them makes "dirty" a statement about the content, which
 * is what the word means to whoever reads the badge.
 */
function serialisable(c: EditorCampaign) {
  return {
    name: c.name,
    bookId: c.bookId,
    domainId: c.domainId,
    from: c.from,
    replyTo: c.replyTo,
    subject: c.subject,
    blocks: blocksOfTree(c.nodes),
    theme: c.theme,
  };
}
