"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/app/setup/steps/shared";
import { deleteDomain, reverifyDomain } from "./actions";

const REFRESH_MS = 15_000;

export function DomainActions({
  id,
  name,
  status,
  provisioned,
}: {
  id: string;
  name: string;
  status: "pending" | "verified" | "failed";
  /** False until the provision job has stored the DKIM tokens. */
  provisioned: boolean;
}) {
  const router = useRouter();
  const [verifying, startVerify] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Until SSE lands (Phase 3) a pending domain re-renders from the server.
  useEffect(() => {
    if (status !== "pending") return;
    // A background tab does not need to re-render.
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [status, router]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          disabled={!provisioned || verifying || deleting}
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
        <Button
          variant="ghost"
          disabled={verifying || deleting}
          onClick={() => {
            if (
              !window.confirm(
                `Delete ${name}? The SES identity and any records we created are removed.`,
              )
            )
              return;
            startDelete(async () => {
              setError(null);
              const res = await deleteDomain(id);
              if (!res.ok) {
                setError(res.error);
                return;
              }
              if (res.data.leftoverDnsRecords > 0)
                window.alert(
                  `${name} removed. ${res.data.leftoverDnsRecords} Cloudflare record(s) could not be deleted; remove them by hand.`,
                );
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
