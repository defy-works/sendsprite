"use client";
import { useState, useTransition, type ReactNode } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { IconSend } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import type { Result } from "@/lib/result";

/** Mirrors `MAX_TEST_RECIPIENTS` in `services/test-send.ts`. */
const MAX_RECIPIENTS = 5;

/**
 * The "send a test" dialog, shared by the campaign and template editors.
 *
 * It owns the recipient list and nothing else: the From address, the template
 * variables and the body all differ between the two callers, so they render
 * their own controls as `children` and close over them in `onSend`. The
 * alternative — a props bag with `variables?`, `domains?`, `from?` — would
 * make this component know about both features and be wrong for the third.
 *
 * The warning is not decoration. A test send is a real SES send: it counts
 * against the team's daily and monthly caps and the SES account quota, it
 * lands in the mail log, and in the SES sandbox it fails unless the recipient
 * is verified — which is the single most common confusion this feature will
 * cause, so it is said before the button rather than in an error afterwards.
 */
export function TestSendDialog({
  open,
  onDismiss,
  defaultTo,
  sandbox,
  children,
  onSend,
}: {
  open: boolean;
  onDismiss: () => void;
  /** Usually the signed-in user's own address. */
  defaultTo: string;
  /** SES is still in the sandbox, so unverified recipients will bounce. */
  sandbox?: boolean;
  children?: ReactNode;
  onSend: (to: string[]) => Promise<Result<{ emailId: string }>>;
}) {
  const toast = useToast();
  const [to, setTo] = useState(defaultTo);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const list = to
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const send = () =>
    start(async () => {
      setError(null);
      try {
        const res = await onSend(list);
        if (!res.ok) return setError(res.error);
        toast({
          tone: "success",
          title: `Test sent to ${list.length === 1 ? list[0] : `${list.length} addresses`}`,
          body: "It is queued like any other send; check the mail log if it does not arrive.",
        });
        onDismiss();
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });

  return (
    <Modal
      open={open}
      onDismiss={onDismiss}
      title="Send a test"
      description="One real email, to you, before it goes to anyone else."
      footer={
        <>
          <Button variant="subtle" onClick={onDismiss}>
            Cancel
          </Button>
          <Button
            icon={<IconSend />}
            loading={pending}
            disabled={list.length === 0 || list.length > MAX_RECIPIENTS}
            onClick={send}
          >
            Send test
          </Button>
        </>
      }
    >
      <Field
        id="test-to"
        label="To"
        hint={`Comma-separated. At most ${MAX_RECIPIENTS}.`}
        error={
          list.length > MAX_RECIPIENTS
            ? `At most ${MAX_RECIPIENTS} addresses per test send.`
            : undefined
        }
      >
        <Input
          id="test-to"
          value={to}
          data-autofocus
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setTo(e.target.value)}
        />
      </Field>

      {children}

      {sandbox && (
        <p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
          This team&apos;s SES account is still in the sandbox, so a test only
          arrives if the recipient address is verified in AWS.
        </p>
      )}
      <p className="text-xs text-white/50">
        A test is a real send: it counts against this team&apos;s limits and
        appears in the mail log, tagged{" "}
        <code className="rounded bg-white/8 px-1 py-0.5">sendsprite_test</code>.
        Its subject is prefixed so it cannot be mistaken for the real thing.
      </p>
      {error && <Alert>{error}</Alert>}
    </Modal>
  );
}
