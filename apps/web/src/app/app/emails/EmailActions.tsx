"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { useConfirm } from "@/components/ui/confirm";
import { cancelEmail, resendEmail } from "./actions";

export function EmailActions({
  id,
  cancellable,
  resendable,
}: {
  id: string;
  cancellable: boolean;
  resendable: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* Only finished emails: false while in flight or once the body is purged. */}
        {resendable && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              start(async () => {
                setError(null);
                const res = await resendEmail(id);
                if (res.ok) router.push(`/app/emails/${res.data.id}`);
                else setError(res.error);
              })
            }
          >
            Resend
          </Button>
        )}
        {cancellable && (
          <Button
            variant="dangerSubtle"
            disabled={busy}
            onClick={async () => {
              const ok = await confirm({
                title: "Cancel this email?",
                body: "It is dropped from the queue and never sent. This cannot be undone.",
                confirmLabel: "Cancel send",
                cancelLabel: "Keep it queued",
                tone: "danger",
              });
              if (!ok) return;
              start(async () => {
                setError(null);
                const res = await cancelEmail(id);
                if (res.ok) router.refresh();
                else setError(res.error);
              });
            }}
          >
            Cancel send
          </Button>
        )}
      </div>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
