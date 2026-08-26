"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { CopyField } from "@/components/ui/CopyField";
import { Alert } from "@/app/setup/steps/shared";
import {
  deleteWebhook,
  rotateSecret,
  sendTestEvent,
  setWebhookEnabled,
  type Result,
} from "../actions";

export function WebhookActions({
  id,
  url,
  enabled,
}: {
  id: string;
  url: string;
  enabled: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The rotated secret lives only in this client state: shown once.
  const [secret, setSecret] = useState<string | null>(null);

  const run = (fn: () => Promise<Result<unknown>>, done?: () => void) =>
    start(async () => {
      setError(null);
      setNotice(null);
      try {
        const res = await fn();
        if (!res.ok) setError(res.error);
        else (done ?? (() => router.refresh()))();
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          disabled={busy || !enabled}
          title={enabled ? undefined : "Enable the webhook first"}
          onClick={() =>
            run(
              () => sendTestEvent(id),
              () => {
                setNotice("Test event queued.");
                router.refresh();
              },
            )
          }
        >
          Send test event
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => run(() => setWebhookEnabled(id, !enabled))}
        >
          {enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            if (
              !window.confirm(
                "Rotate the signing secret? Deliveries from now on are signed with the new one.",
              )
            )
              return;
            run(
              async () => {
                const res = await rotateSecret(id);
                if (res.ok) setSecret(res.data.secret);
                return res;
              },
              () => undefined,
            );
          }}
        >
          Rotate secret
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`Delete the endpoint ${url}?`)) return;
            run(
              () => deleteWebhook(id),
              () => router.push("/app/webhooks"),
            );
          }}
        >
          Delete
        </Button>
      </div>
      {secret && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-white/70">
            New signing secret — copy it now, we won&apos;t show it again.
          </p>
          <CopyField value={secret} />
          <div>
            <Button size="sm" variant="ghost" onClick={() => setSecret(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
      {notice && <p className="text-sm text-white/70">{notice}</p>}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
