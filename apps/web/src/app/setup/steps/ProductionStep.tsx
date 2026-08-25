"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Select } from "@/components/ui/Select";
import { StatusDot, type Status } from "@/components/ui/StatusDot";
import { Textarea } from "@/components/ui/Textarea";
import type { WizardProps } from "../types";
import { refreshAccount, requestProduction } from "../actions";
import { Alert, Heading, Notice } from "./shared";

const DOT: Record<string, Status> = {
  production: "ok",
  requested: "pending",
  sandbox: "warning",
};

export function ProductionStep({ settings }: WizardProps) {
  const router = useRouter();
  const status = settings.sesAccountStatus;
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => {
      const res = await requestProduction(fd);
      if (res.ok) router.refresh();
      return res;
    },
    null,
  );
  const [checking, startCheck] = useTransition();
  const [checkError, setCheckError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <Heading>SES production access</Heading>
      <p className="text-sm text-white/65">
        New SES accounts start in the sandbox: you can only send to verified
        addresses, 200 per day. Production access lifts that; AWS reviews the
        request, usually within a day.
      </p>
      <div className="glass flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm">
        <StatusDot
          status={status ? (DOT[status] ?? "off") : "off"}
          label={status ?? "unknown"}
        />
        {settings.sesDailyQuota != null && (
          <span className="text-white/65">
            {settings.sesDailyQuota.toLocaleString()} / day
          </span>
        )}
        {settings.sesMaxSendRate != null && (
          <span className="text-white/65">{settings.sesMaxSendRate} / s</span>
        )}
      </div>

      {settings.awsMode === "none" && (
        <Notice>Connect AWS first; production access is per account.</Notice>
      )}
      {settings.sesReviewStatus === "DENIED" && (
        <Notice>
          AWS denied the last request. Reply to their case with more detail
          before submitting again.
        </Notice>
      )}

      {status === "production" && (
        <p className="text-sm text-white/75">
          You&apos;re in production. Nothing to do here.
        </p>
      )}

      {status === "requested" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-white/75">
            AWS is reviewing your request (usually &lt; 24 h). Sendsprite checks
            hourly; you can also check now.
          </p>
          <div>
            <Button
              variant="secondary"
              disabled={checking}
              onClick={() =>
                startCheck(async () => {
                  setCheckError(null);
                  const res = await refreshAccount();
                  if (!res.ok) setCheckError(res.error);
                  else router.refresh();
                })
              }
            >
              {checking ? "Checking…" : "Check now"}
            </Button>
          </div>
          {checkError && <Alert>{checkError}</Alert>}
        </div>
      )}

      {status !== "production" && status !== "requested" && (
        <form action={action} className="flex flex-col gap-3">
          <div>
            <Label htmlFor="websiteUrl">Website URL</Label>
            <Input
              id="websiteUrl"
              name="websiteUrl"
              type="url"
              placeholder="https://example.com"
              required
            />
          </div>
          <div>
            <Label htmlFor="mailType">Mail type</Label>
            <Select id="mailType" name="mailType" defaultValue="TRANSACTIONAL">
              <option value="TRANSACTIONAL">Transactional</option>
              <option value="MARKETING">Marketing</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="useCase">Use case</Label>
            <Textarea
              id="useCase"
              name="useCase"
              required
              minLength={20}
              maxLength={5000}
              placeholder="What you send, to whom, how you collect addresses and handle bounces and complaints."
            />
          </div>
          <div>
            <Label htmlFor="contactEmail">Contact email (optional)</Label>
            <Input id="contactEmail" name="contactEmail" type="email" />
          </div>
          <div>
            <Button
              type="submit"
              disabled={pending || settings.awsMode === "none"}
            >
              {pending ? "Submitting…" : "Request production access"}
            </Button>
          </div>
          {state && !state.ok && <Alert>{state.error}</Alert>}
        </form>
      )}

      <div className="flex items-center gap-3">
        {status === "production" ? (
          <Button asChild>
            <Link href="/setup?step=cloudflare">Continue</Link>
          </Button>
        ) : (
          <Button
            variant="ghost"
            onClick={() => router.push("/setup?step=cloudflare")}
          >
            Skip for now
          </Button>
        )}
      </div>
    </div>
  );
}
