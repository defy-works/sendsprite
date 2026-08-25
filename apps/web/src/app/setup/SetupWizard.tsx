"use client";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { AwsStep } from "./steps/AwsStep";
import { ProductionStep } from "./steps/ProductionStep";
import { CloudflareStep } from "./steps/CloudflareStep";
import { DoneStep } from "./steps/DoneStep";
import { STEPS, type Step, type WizardProps } from "./types";

const LABELS: Record<Step, string> = {
  aws: "AWS",
  production: "Production access",
  cloudflare: "Cloudflare",
  done: "Done",
};

export function SetupWizard(props: WizardProps) {
  const { step } = props;
  const current = STEPS.indexOf(step);
  return (
    <div className="flex flex-col gap-6">
      <ol className="flex flex-wrap gap-x-5 gap-y-2">
        {STEPS.map((s, i) => (
          <li key={s}>
            <Link
              href={`/setup?step=${s}`}
              aria-current={s === step ? "step" : undefined}
              className={cn(
                "num-stamp transition-colors",
                i === current
                  ? "text-indigo-300"
                  : i < current
                    ? "text-white/60 hover:text-white/80"
                    : "text-white/35 hover:text-white/60",
              )}
            >
              {i + 1} · {LABELS[s]}
            </Link>
          </li>
        ))}
      </ol>
      {step === "aws" && <AwsStep {...props} />}
      {step === "production" && <ProductionStep {...props} />}
      {step === "cloudflare" && <CloudflareStep {...props} />}
      {step === "done" && <DoneStep {...props} />}
    </div>
  );
}
