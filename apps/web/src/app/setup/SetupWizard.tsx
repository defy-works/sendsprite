"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { IconArrowRight, IconCheck } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { AwsStep } from "./steps/AwsStep";
import { ProductionStep } from "./steps/ProductionStep";
import { CloudflareStep } from "./steps/CloudflareStep";
import { DoneStep } from "./steps/DoneStep";
import { finishSetup } from "./actions";
import { STEPS, type Step, type WizardProps } from "./types";

const LABELS: Record<Step, string> = {
  aws: "AWS",
  production: "Production access",
  cloudflare: "Cloudflare",
  done: "Done",
};

/** Which steps this team has actually finished, for the ticks in the rail. */
function completion(p: WizardProps): Record<Step, boolean> {
  return {
    aws: p.settings.awsConnected,
    production: p.settings.sesAccountStatus === "production",
    cloudflare: Boolean(p.settings.cloudflareConnectedAt),
    done: p.settings.setupCompleted,
  };
}

export function SetupWizard(props: WizardProps) {
  const { step } = props;
  // A step nobody on this instance can complete is not a step. Without an
  // OAuth client the Cloudflare step renders nothing, and a numbered rail
  // with an empty stop on it is worse than three stops.
  const steps: readonly Step[] = props.oauthAvailable
    ? STEPS
    : STEPS.filter((s) => s !== "cloudflare");
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [leaving, startLeave] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const current = steps.indexOf(step);
  const done = completion(props);

  /**
   * The way out.
   *
   * There was none: `/app` redirected here until `setupCompleted`, and the
   * only thing that set that flag was a button on the last step. An admin who
   * opened the wizard to read what it wanted, or who needed to invite a
   * colleague first, was stuck in it. Leaving does not pretend the team is
   * configured — `setupCompleted` only means the wizard has been seen, and
   * every page carries a banner naming what is still missing.
   */
  const leave = async () => {
    if (!props.settings.awsConnected) {
      const ok = await confirm({
        title: "Leave setup without connecting AWS?",
        body: "The dashboard opens, but this team cannot send anything: domains will not verify and campaigns will not queue. You can pick this up again from Settings → Sending.",
        confirmLabel: "Go to the dashboard",
        cancelLabel: "Stay here",
      });
      if (!ok) return;
    }
    startLeave(async () => {
      setError(null);
      const res = await finishSetup();
      if (!res.ok) return setError(res.error);
      toast({
        title: "Setup closed",
        body: "Finish connecting from Settings → Sending whenever you are ready.",
      });
      router.push("/app");
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <nav aria-label="Setup steps">
          <ol className="flex flex-wrap gap-x-5 gap-y-2">
            {steps.map((s, i) => (
              <li key={s}>
                <Link
                  href={`/setup?step=${s}`}
                  aria-current={s === step ? "step" : undefined}
                  className={cn(
                    "num-stamp inline-flex items-center gap-1.5 no-underline transition-colors",
                    i === current
                      ? "text-indigo-300"
                      : done[s]
                        ? "text-white/60 hover:text-white/80"
                        : "text-white/35 hover:text-white/60",
                  )}
                >
                  {done[s] ? (
                    <IconCheck className="text-[13px] text-success" />
                  ) : (
                    <span aria-hidden>{i + 1}</span>
                  )}
                  {LABELS[s]}
                </Link>
              </li>
            ))}
          </ol>
        </nav>
        <Button
          size="sm"
          variant="ghost"
          loading={leaving}
          onClick={() => void leave()}
          className="text-white/50 hover:text-white"
        >
          Skip for now
          <IconArrowRight className="text-xs" />
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
      {step === "aws" && <AwsStep {...props} />}
      {step === "production" && <ProductionStep {...props} />}
      {step === "cloudflare" && <CloudflareStep {...props} />}
      {step === "done" && <DoneStep {...props} />}
    </div>
  );
}
