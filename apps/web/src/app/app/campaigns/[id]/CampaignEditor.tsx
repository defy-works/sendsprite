"use client";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { CampaignStatus } from "@sendsprite/shared";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Link } from "@/components/ui/Link";
import { Select } from "@/components/ui/Select";
import {
  createCampaign,
  updateCampaign,
  type CampaignDraft,
  type Result,
} from "../actions";
import {
  BLOCK_KINDS,
  BLOCK_LABELS,
  blockDefaults,
  blocksOf,
  editorBlock,
  moveBlockById,
  previewCampaign,
  removeBlock,
  replaceBlock,
  type EditorBlock,
} from "../preview";
import { BlockCard } from "./blocks/BlockCard";

export interface BookOption {
  id: string;
  name: string;
  contactCount: number;
}
export interface DomainOption {
  id: string;
  name: string;
}

/** Everything the form holds. `blocks` carry editor-local ids; see `preview.ts`. */
export interface EditorCampaign {
  name: string;
  bookId: string;
  domainId: string;
  from: string;
  /** `""` is "no reply-to"; the actions module translates it per path. */
  replyTo: string;
  subject: string;
  blocks: EditorBlock[];
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
}) {
  const router = useRouter();
  const [c, setC] = useState(campaign);
  const [liveStatus, setLiveStatus] = useState(status);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /** The last state written to the database, as a string, so edits are detectable. */
  const [committed, setCommitted] = useState(() => JSON.stringify(campaign));

  const dirty = JSON.stringify(c) !== committed;
  const locked = mode === "edit" ? LOCKED[liveStatus] : null;
  const readOnly = !canManage || locked !== null;

  const set = <K extends keyof EditorCampaign>(k: K, v: EditorCampaign[K]) => {
    setSaved(false);
    setC((prev) => ({ ...prev, [k]: v }));
  };
  const setBlocks = (blocks: EditorBlock[]) => set("blocks", blocks);

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

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so a click into a text
    // field inside a card is still a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const onDragEnd = (e: DragEndEvent) => {
    const over = e.over;
    if (!over || over.id === e.active.id) return;
    setBlocks(moveBlockById(c.blocks, String(e.active.id), String(over.id)));
  };

  /**
   * The live preview runs the **same** `renderBlocks` the send runs. There is
   * no React renderer for blocks anywhere in this app, deliberately — see
   * `preview.ts`.
   */
  const preview = useMemo(
    () => previewCampaign(blocksOf(c.blocks)),
    [c.blocks],
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
    blocks: blocksOf(state.blocks),
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
        setCommitted(JSON.stringify(state));
        setSaved(true);
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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Link href="/app/campaigns" className="num-stamp no-underline">
            ← Campaigns
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-medium">
              {mode === "create" ? "New campaign" : c.name || "Untitled"}
            </h1>
            {mode === "edit" && (
              <Badge variant={STATUS_VARIANT[liveStatus]}>{liveStatus}</Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {dirty && !readOnly && (
            <Badge variant="warning">Unsaved changes</Badge>
          )}
          {saved && !dirty && (
            <span className="text-sm text-white/60">Saved.</span>
          )}
          {readOnly ? (
            <span className="max-w-md text-right text-sm text-white/60">
              {locked ?? NO_PERMISSION}
            </span>
          ) : (
            <Button
              disabled={pending || (mode === "edit" && !dirty)}
              onClick={save}
            >
              {pending ? "Saving…" : mode === "create" ? "Create" : "Save"}
            </Button>
          )}
        </div>
      </div>

      {error && <Alert>{error}</Alert>}

      {liveStatus === "scheduled" && !readOnly && (
        <p className="text-sm text-amber-300">
          This campaign is scheduled. Saving an edit returns it to a draft and
          clears the send time, so nobody ships an unreviewed change on the old
          timer — reschedule it when you are done.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Settings</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              <div>
                <Label htmlFor="cmp-name">Name</Label>
                <Input
                  id="cmp-name"
                  value={c.name}
                  maxLength={200}
                  disabled={readOnly}
                  onChange={(e) => set("name", e.target.value)}
                />
                <p className="mt-1 text-xs text-white/50">
                  Internal only. Recipients never see it.
                </p>
              </div>

              <div>
                <Label htmlFor="cmp-book">Contact book</Label>
                <Select
                  id="cmp-book"
                  value={c.bookId}
                  disabled={readOnly}
                  onChange={(e) => set("bookId", e.target.value)}
                >
                  <option value="">Choose a book…</option>
                  {/* A campaign outlives its book: `book_id` carries no
                      foreign key, so the stored id can point at nothing.
                      Kept as an option so the row still renders what it
                      says, with a warning telling the author to repoint it. */}
                  {bookMissing && (
                    <option value={c.bookId}>Deleted book ({c.bookId})</option>
                  )}
                  {books.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} — {b.contactCount.toLocaleString("en-US")}{" "}
                      contacts
                    </option>
                  ))}
                </Select>
                {bookMissing && (
                  <p className="mt-1 text-xs text-amber-300">
                    The book this campaign was drawn from has been deleted. Pick
                    another before saving.
                  </p>
                )}
                <p className="mt-1 text-xs text-white/50">
                  Everyone in it who is subscribed and not suppressed — consent
                  and deliverability are separate, and both have to say yes.
                </p>
              </div>

              <div>
                <Label htmlFor="cmp-domain">Sending domain</Label>
                <Select
                  id="cmp-domain"
                  value={c.domainId}
                  disabled={readOnly}
                  onChange={(e) => set("domainId", e.target.value)}
                >
                  <option value="">Choose a domain…</option>
                  {domainMissing && (
                    <option value={c.domainId}>
                      Deleted or unverified ({c.domainId})
                    </option>
                  )}
                  {domains.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
                {domainMissing && (
                  <p className="mt-1 text-xs text-amber-300">
                    This domain is gone or no longer verified. A campaign sent
                    from it would fail for every recipient.
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="cmp-from">From</Label>
                <Input
                  id="cmp-from"
                  value={c.from}
                  placeholder="hello@yourdomain.com"
                  disabled={readOnly}
                  onChange={(e) => set("from", e.target.value)}
                />
                <p className="mt-1 text-xs text-white/50">
                  Must be an address at the domain above.
                </p>
              </div>

              <div>
                <Label htmlFor="cmp-replyto">Reply-to (optional)</Label>
                <Input
                  id="cmp-replyto"
                  value={c.replyTo}
                  placeholder="none"
                  disabled={readOnly}
                  onChange={(e) => set("replyTo", e.target.value)}
                />
              </div>

              <div>
                <Label htmlFor="cmp-subject">Subject</Label>
                <Input
                  id="cmp-subject"
                  value={c.subject}
                  disabled={readOnly}
                  onChange={(e) => set("subject", e.target.value)}
                />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Body</CardTitle>
              <span className="text-xs text-white/40">
                {c.blocks.length} block{c.blocks.length === 1 ? "" : "s"}
              </span>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              {c.blocks.length === 0 && (
                <p className="text-sm text-white/60">
                  Nothing in the body yet. Add a heading, then some text.
                </p>
              )}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={c.blocks.map((b) => b.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <ul className="flex list-none flex-col gap-3">
                    {c.blocks.map((b, i) => (
                      <BlockCard
                        key={b.id}
                        item={b}
                        index={i}
                        count={c.blocks.length}
                        readOnly={readOnly}
                        invalid={!preview.ok && preview.index === i}
                        onChange={(block) =>
                          setBlocks(replaceBlock(c.blocks, b.id, block))
                        }
                        onRemove={() => setBlocks(removeBlock(c.blocks, b.id))}
                      />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>

              {!readOnly && (
                <div className="flex flex-wrap gap-2 border-t border-white/8 pt-3">
                  {BLOCK_KINDS.map((kind) => (
                    <Button
                      key={kind}
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setBlocks([
                          ...c.blocks,
                          editorBlock(blockDefaults(kind)),
                        ])
                      }
                    >
                      + {BLOCK_LABELS[kind]}
                    </Button>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        <Card className="lg:sticky lg:top-6 lg:self-start">
          <CardHeader>
            <CardTitle>Preview</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            <p className="text-sm break-words text-white/65">
              <span className="text-white/40">Subject </span>
              {c.subject || <span className="text-white/40">(none)</span>}
            </p>
            {preview.ok ? (
              <>
                {/* The same empty sandbox as the mail-log detail view and the
                    template preview. The block contract refuses `javascript:`
                    URLs, so this is defence in depth — but the frame renders
                    customer-authored content inside a dashboard session, and
                    one bug in the URL check must not become account takeover. */}
                <iframe
                  title="Campaign preview"
                  sandbox=""
                  srcDoc={preview.html}
                  className="h-[36rem] w-full rounded-lg border border-white/10 bg-white"
                />
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
              Rendered by the same code the send uses, inside a sandboxed frame
              that runs nothing. The unsubscribe footer is added per recipient.
            </p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
