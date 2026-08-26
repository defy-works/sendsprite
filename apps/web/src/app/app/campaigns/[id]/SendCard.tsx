"use client";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import type {
  AudiencePreview,
  CampaignCounts,
  CampaignStatus,
} from "@sendsprite/shared";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { armCampaign, cancelCampaign } from "../actions";
import {
  STATUS_PLAN,
  cancelConfirmation,
  capNotice,
  confirmationMatches,
  people,
  sendConfirmation,
  whyCannotSend,
  type CapPreflight,
} from "../send";

/**
 * The control that mails everybody.
 *
 * Every sentence it shows and every rule about what a status allows lives in
 * `send.ts`, so the copy a customer reads before an irreversible act is under
 * test. This file is the interaction: when the dialog opens, what it takes to
 * enable the button, and what happens after.
 *
 * ## Three gates on the send, not one
 *
 * The typed confirmation is checked in three places on purpose, because two of
 * them can be got round:
 *
 * 1. the confirm button is `disabled` until the name matches — which stops a
 *    click and nothing else;
 * 2. the submit handler re-checks, because a `<form>` submits on Enter and a
 *    disabled button does not prevent that;
 * 3. `armCampaign` re-checks server-side against the stored name, because a
 *    Server Function is a POST endpoint reachable without this page at all.
 *
 * Only the third is a real control. The first two are what make the dialog
 * feel honest rather than decorative.
 */
export function SendCard({
  campaignId,
  name,
  status,
  canManage,
  bookName,
  bookExists,
  audience,
  counts,
  scheduledLabel,
  cap,
}: {
  campaignId: string;
  name: string;
  status: CampaignStatus;
  canManage: boolean;
  bookName: string | null;
  bookExists: boolean;
  audience: AudiencePreview;
  counts: CampaignCounts;
  /** The armed time, already formatted server-side; `null` when unarmed. */
  scheduledLabel: string | null;
  /** Computed on the server against this campaign's eligible count. */
  cap: CapPreflight;
}) {
  const router = useRouter();
  const [live, setLive] = useState(status);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** `""` means "as soon as possible"; anything else is a `datetime-local`. */
  const [at, setAt] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [typed, setTyped] = useState("");

  const plan = STATUS_PLAN[live];
  const blocked = whyCannotSend({
    status: live,
    canManage,
    eligible: audience.eligible,
    bookExists,
  });
  const notice = capNotice(audience.eligible, cap);
  // Narrowed once: `plan.cancel` inside a callback is a property read the
  // compiler cannot keep narrowed.
  const cancelKind = plan.cancel;

  const openArm = () => {
    setError(null);
    let when: Date | null = null;
    if (at !== "") {
      when = new Date(at);
      if (Number.isNaN(when.getTime()))
        return setError("That is not a valid date and time.");
      // Refused rather than clamped to now, exactly as the service refuses it:
      // a past time is a timezone mistake far more often than a stale clock,
      // and clamping a timezone mistake mails the list immediately.
      if (when.getTime() <= Date.now())
        return setError(
          "That time has already passed. Pick a future time, or send as soon as possible.",
        );
    }
    setTyped("");
    setDialog({ kind: "arm", at: when });
  };

  const arm = (when: Date | null) => {
    // The same check the button's `disabled` makes, repeated because Enter
    // submits a form whether or not its button is disabled.
    if (!confirmationMatches(typed, name)) return;
    start(async () => {
      setError(null);
      try {
        const res = await armCampaign(campaignId, {
          scheduledAt: when ? when.toISOString() : null,
          confirmation: typed,
        });
        if (!res.ok) return setError(res.error);
        setDialog(null);
        setLive(res.data.status);
        router.refresh();
      } catch {
        setError("Something went wrong. Nothing was sent. Please try again.");
      }
    });
  };

  const stop = () => {
    start(async () => {
      setError(null);
      try {
        const res = await cancelCampaign(campaignId);
        if (!res.ok) return setError(res.error);
        setDialog(null);
        setLive(res.data.status);
        router.refresh();
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Send</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <p className="text-sm text-white/70">{plan.summary}</p>

        {live === "scheduled" && scheduledLabel && (
          <p className="text-sm text-amber-300">
            Scheduled for {scheduledLabel}. It goes out on its own — unschedule
            it if that is not what you want.
          </p>
        )}

        {error && <Alert>{error}</Alert>}

        {plan.canArm && !blocked && (
          <div className="flex flex-col gap-3 border-t border-white/8 pt-4">
            <div>
              <Label htmlFor="cmp-when">When</Label>
              <Input
                id="cmp-when"
                type="datetime-local"
                value={at}
                disabled={pending}
                onChange={(e) => setAt(e.target.value)}
              />
              <p className="mt-1 text-xs text-white/50">
                Leave empty to send as soon as possible — within a minute. Times
                are in your own time zone.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={openArm} disabled={pending}>
                {at === ""
                  ? `Send to ${people(audience.eligible)}…`
                  : "Schedule…"}
              </Button>
              <span className="text-xs text-white/45">
                You will be asked to type the campaign name.
              </span>
            </div>
          </div>
        )}

        {blocked && <p className="text-sm text-white/60">{blocked}</p>}

        {cancelKind && canManage && (
          <div className="border-t border-white/8 pt-4">
            <Button
              variant={cancelKind === "stop" ? "danger" : "secondary"}
              disabled={pending}
              onClick={() => {
                setError(null);
                setDialog({ kind: "cancel", cancel: cancelKind });
              }}
            >
              {cancelKind === "stop" ? "Stop sending…" : "Unschedule"}
            </Button>
            {cancelKind === "stop" && (
              <p className="mt-2 text-xs text-white/50">
                Stops the recipients not reached yet. Mail already handed to SES
                cannot be recalled.
              </p>
            )}
          </div>
        )}

        {/* Shown on the card as well as in the dialog: somebody deciding
            whether to send at all should not have to open the irreversible
            dialog to find out the send will not finish. */}
        {plan.canArm && notice && (
          <p
            className={
              notice.level === "warning"
                ? "border-t border-white/8 pt-4 text-xs text-amber-300"
                : "border-t border-white/8 pt-4 text-xs text-white/45"
            }
          >
            {notice.text}
          </p>
        )}
      </CardBody>

      {dialog?.kind === "arm" && (
        <ArmDialog
          name={name}
          bookName={bookName}
          audience={audience}
          at={dialog.at}
          notice={notice}
          typed={typed}
          setTyped={setTyped}
          pending={pending}
          error={error}
          onConfirm={() => arm(dialog.at)}
          onDismiss={() => setDialog(null)}
        />
      )}

      {dialog?.kind === "cancel" && (
        <CancelDialog
          kind={dialog.cancel}
          name={name}
          counts={counts}
          pending={pending}
          error={error}
          onConfirm={stop}
          onDismiss={() => setDialog(null)}
        />
      )}
    </Card>
  );
}

type Dialog =
  | { kind: "arm"; at: Date | null }
  | { kind: "cancel"; cancel: "unschedule" | "stop" };

/**
 * A modal panel.
 *
 * Not `window.confirm`, which the rest of the dashboard uses for its ordinary
 * deletes: this one has to show four facts, a cap warning and a text field,
 * and a native confirm can show none of them. Escape dismisses, the backdrop
 * does not — a stray click outside a dialog should not silently discard a
 * decision this size, in either direction.
 */
function Modal({
  labelledBy,
  onDismiss,
  children,
}: {
  labelledBy: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="glass flex max-h-full w-full max-w-lg flex-col gap-4 overflow-y-auto p-6"
      >
        {children}
      </div>
    </div>
  );
}

function ArmDialog({
  name,
  bookName,
  audience,
  at,
  notice,
  typed,
  setTyped,
  pending,
  error,
  onConfirm,
  onDismiss,
}: {
  name: string;
  bookName: string | null;
  audience: AudiencePreview;
  at: Date | null;
  notice: ReturnType<typeof capNotice>;
  typed: string;
  setTyped: (s: string) => void;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const titleId = useId();
  const fieldId = useId();
  const copy = sendConfirmation({
    name,
    bookName,
    audience,
    scheduledAt: at,
  });
  const confirmed = confirmationMatches(typed, name);

  return (
    <Modal labelledBy={titleId} onDismiss={onDismiss}>
      <h2 id={titleId} className="text-lg font-medium">
        {copy.title}
      </h2>

      <dl className="flex flex-col gap-2 border-y border-white/8 py-4 text-sm">
        {copy.facts.map((f) => (
          <div key={f.label} className="flex flex-wrap gap-x-3">
            <dt className="w-28 shrink-0 text-xs tracking-wide text-white/45 uppercase">
              {f.label}
            </dt>
            <dd className="flex-1 break-words text-white/85">{f.value}</dd>
          </div>
        ))}
      </dl>

      <p className="text-sm text-amber-300">{copy.irreversible}</p>

      {notice && (
        <p
          className={
            notice.level === "warning"
              ? "text-sm text-amber-300"
              : "text-xs text-white/50"
          }
        >
          {notice.text}
        </p>
      )}

      {error && <Alert>{error}</Alert>}

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm();
        }}
      >
        <Label htmlFor={fieldId}>{copy.prompt}</Label>
        <Input
          id={fieldId}
          value={typed}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder={name}
          disabled={pending}
          onChange={(e) => setTyped(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap justify-end gap-3">
          <Button variant="ghost" onClick={onDismiss} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={!confirmed || pending}>
            {pending ? "Sending…" : copy.action}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CancelDialog({
  kind,
  name,
  counts,
  pending,
  error,
  onConfirm,
  onDismiss,
}: {
  kind: "unschedule" | "stop";
  name: string;
  counts: CampaignCounts;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const titleId = useId();
  const copy = cancelConfirmation({ kind, name, counts });
  return (
    <Modal labelledBy={titleId} onDismiss={onDismiss}>
      <h2 id={titleId} className="text-lg font-medium">
        {copy.title}
      </h2>
      <p className="text-sm text-white/75">{copy.body}</p>
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="ghost" onClick={onDismiss} disabled={pending}>
          {copy.dismiss}
        </Button>
        <Button
          variant={kind === "stop" ? "danger" : "primary"}
          onClick={onConfirm}
          disabled={pending}
        >
          {pending ? "Stopping…" : copy.action}
        </Button>
      </div>
    </Modal>
  );
}
