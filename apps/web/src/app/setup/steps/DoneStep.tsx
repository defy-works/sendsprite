"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/StatusDot";
import type { WizardProps } from "../types";
import { finishSetup } from "../actions";
import { Alert, Heading } from "./shared";

export function DoneStep({ settings }: WizardProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const aws = settings.awsMode !== "none";
  const prod = settings.sesAccountStatus === "production";
  const cf = Boolean(settings.cloudflareConnectedAt);
  return (
    <div className="flex flex-col gap-5">
      <Heading>{aws ? "You're set" : "Almost there"}</Heading>
      <div className="glass flex flex-col gap-2 p-4">
        <StatusDot
          status={aws ? "ok" : "error"}
          label={
            aws
              ? `AWS connected · ${settings.awsAccountId ?? ""} · ${settings.awsRegion ?? ""}`
              : "AWS not connected"
          }
        />
        <StatusDot
          status={
            prod
              ? "ok"
              : settings.sesAccountStatus === "requested"
                ? "pending"
                : "warning"
          }
          label={
            prod
              ? "SES production access"
              : settings.sesAccountStatus === "requested"
                ? "SES production access requested"
                : "SES sandbox (verified recipients only)"
          }
        />
        <StatusDot
          status={cf ? "ok" : "off"}
          label={
            cf ? "Cloudflare connected" : "Cloudflare skipped (manual DNS)"
          }
        />
      </div>
      {!aws && (
        <p className="text-sm text-white/65">
          You can open the dashboard now and connect AWS later from Settings →
          Instance, but nothing will send until then.
        </p>
      )}
      <div>
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              const res = await finishSetup();
              if (!res.ok) setError(res.error);
              else router.push("/app");
            })
          }
        >
          {pending ? "Opening…" : "Go to dashboard"}
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
