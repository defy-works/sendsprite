"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Textarea";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { suspendOrg } from "../../actions-org";

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(iso));

/**
 * Suspending a team's sending.
 *
 * The reason is shown to the team verbatim in the refusal every send path
 * returns, which is why the field says so above the box rather than in a
 * tooltip: an operator typing an internal note into a field a customer will
 * read is a mistake worth preventing before it is made, not after.
 */
export function SuspendPanel({
  teamId,
  teamName,
  suspendedAt,
  suspendedReason,
}: {
  teamId: string;
  teamName: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [reason, setReason] = useState(suspendedReason ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (next: boolean) =>
    start(async () => {
      setError(null);
      try {
        const res = await suspendOrg(teamId, next, reason);
        if (!res.ok) return setError(res.error);
        toast({
          tone: next ? "error" : "success",
          title: next ? `${teamName} suspended` : `${teamName} can send again`,
          duration: 4000,
        });
        router.refresh();
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });

  const suspend = async () => {
    const ok = await confirm({
      title: `Suspend ${teamName}?`,
      body: "Every send this team attempts is refused immediately — REST, SMTP, the dashboard and any campaign already mid-schedule. Their data is untouched and they can sign in as usual.",
      confirmLabel: "Suspend sending",
      tone: "danger",
    });
    if (ok) run(true);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium">Suspension</h2>
        <p className="text-sm text-white/65">
          {suspendedAt
            ? `Suspended ${when(suspendedAt)} UTC. Nothing this team submits is being sent.`
            : "Stops this team sending without touching anything it owns. Reversible."}
        </p>
      </div>
      <Field
        id="suspend-reason"
        label="Reason"
        hint="Shown to the team word for word in every refused send. Keep it something a customer can act on."
      >
        <Textarea
          id="suspend-reason"
          value={reason}
          maxLength={500}
          rows={2}
          placeholder="Complaint rate above 0.3% — reply to the open ticket before sending again."
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        {suspendedAt ? (
          <>
            <Button
              variant="primary"
              loading={pending}
              onClick={() => run(false)}
            >
              Lift the suspension
            </Button>
            <Button
              variant="subtle"
              disabled={pending || reason === (suspendedReason ?? "")}
              onClick={() => run(true)}
            >
              Update the reason
            </Button>
          </>
        ) : (
          <Button
            variant="danger"
            loading={pending}
            onClick={() => void suspend()}
          >
            Suspend sending
          </Button>
        )}
      </div>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
