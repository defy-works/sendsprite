"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/toast";
import { formatWhen } from "@/lib/format";
import { applyDns } from "./actions";

/**
 * The one button that writes to a Cloudflare zone. Nothing lands there on
 * its own: provisioning stores what SES issued and this is the click that
 * applies it. Re-applying is safe (upsert by type + name) and is how a record
 * someone edited or deleted by hand gets repaired.
 */
export function ApplyDns({
  id,
  zone,
  appliedAt,
}: {
  id: string;
  /** Zone name for the copy; null when detection failed. */
  zone: string | null;
  /** ISO timestamp of the last apply, or null if never. */
  appliedAt: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const applied = appliedAt ? new Date(appliedAt) : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={applied ? "secondary" : "primary"}
          loading={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              const res = await applyDns(id);
              if (!res.ok) {
                setError(res.error);
                return;
              }
              toast({
                tone: "success",
                title: applied
                  ? "Records re-applied"
                  : "Records applied to Cloudflare",
                body: "SES is re-checked in about 30 seconds; this page updates on its own.",
              });
              router.refresh();
            })
          }
        >
          {applied ? "Re-apply to Cloudflare" : "Apply to Cloudflare"}
        </Button>
        <span className="text-sm text-white/65">
          {applied
            ? `Applied ${formatWhen(applied)}. Re-apply repairs a record that was changed by hand.`
            : `Nothing is written to ${zone ?? "your zone"} until you click.`}
        </span>
      </div>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
