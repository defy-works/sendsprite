"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { deleteDomain, retryProvisioning, reverifyDomain } from "./actions";

export function DomainActions({
  id,
  name,
  provisioned,
  retryable,
}: {
  id: string;
  name: string;
  /** False until the provision job has stored the DKIM tokens. */
  provisioned: boolean;
  /** Provisioning never ran or failed for good: offer to re-send the job. */
  retryable: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [verifying, startVerify] = useTransition();
  const [retrying, startRetry] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const busy = verifying || retrying || deleting;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          disabled={!provisioned || busy}
          title={provisioned ? undefined : "Waiting for provisioning…"}
          onClick={() =>
            startVerify(async () => {
              setError(null);
              const res = await reverifyDomain(id);
              if (!res.ok) setError(res.error);
              else router.refresh();
            })
          }
        >
          {verifying ? "Checking…" : "Re-verify"}
        </Button>
        {retryable && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              startRetry(async () => {
                setError(null);
                const res = await retryProvisioning(id);
                if (!res.ok) setError(res.error);
                else router.refresh();
              })
            }
          >
            {retrying ? "Queuing…" : "Retry provisioning"}
          </Button>
        )}
        <Button
          variant="dangerSubtle"
          disabled={busy}
          onClick={async () => {
            const ok = await confirm({
              title: `Delete ${name}?`,
              body: "The SES identity and any DNS records we created for it are removed. Mail cannot be sent from this domain again until it is re-added and re-verified.",
              confirmLabel: "Delete domain",
              tone: "danger",
              typeToConfirm: name,
            });
            if (!ok) return;
            startDelete(async () => {
              setError(null);
              const res = await deleteDomain(id);
              if (!res.ok) {
                setError(res.error);
                return;
              }
              if (res.data.leftoverDnsRecords > 0)
                toast({
                  tone: "error",
                  title: `${name} removed, with leftovers`,
                  body: `${res.data.leftoverDnsRecords} Cloudflare record(s) could not be deleted. Remove them by hand or the zone keeps advertising a domain we no longer send for.`,
                });
              else toast({ tone: "success", title: `${name} removed` });
              router.push("/app/domains");
            });
          }}
        >
          {deleting ? "Deleting…" : "Delete"}
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
