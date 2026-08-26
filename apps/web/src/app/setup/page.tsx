import Link from "next/link";
import { env } from "@/env";
import { SES_REGIONS } from "@/lib/aws/regions";
import { requireOwner } from "@/lib/session";
import { getInstanceSettings } from "@/services/instance-settings";
import { oauthAvailable } from "@/services/cloudflare-connect";
import { SetupWizard } from "./SetupWizard";
import { STEPS, type Step, type WizardSettings } from "./types";

export const metadata = { title: "Setup" };

const isStep = (v: unknown): v is Step =>
  (STEPS as readonly string[]).includes(String(v));

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOwner();
  const s = await getInstanceSettings();
  const cfOauth = oauthAvailable();
  // Only serialisable, non-secret fields cross into the client tree.
  const settings: WizardSettings = {
    awsMode: s.awsMode,
    awsRegion: s.awsRegion,
    awsAccountId: s.awsAccountId,
    sesAccountStatus: s.sesAccountStatus,
    sesReviewStatus: s.sesReviewStatus,
    sesDailyQuota: s.sesDailyQuota,
    sesMaxSendRate: s.sesMaxSendRate,
    cloudflareConnectedAt: s.cloudflareConnectedAt?.toISOString() ?? null,
    cloudflareAccountName: s.cloudflareAccountName,
    setupCompleted: s.setupCompleted,
  };
  const requested = (await searchParams).step;
  const step: Step = isStep(requested)
    ? requested
    : s.awsMode === "none"
      ? "aws"
      : s.sesAccountStatus !== "production"
        ? "production"
        : !s.cloudflareConnectedAt
          ? "cloudflare"
          : "done";
  return (
    <main className="grid-hairlines flex min-h-dvh items-center justify-center p-6">
      <div className="glass-strong w-full max-w-2xl p-8">
        <Link href="/" className="num-stamp">
          Sendsprite
        </Link>
        <h1 className="sr-only">Setup</h1>
        <div className="mt-6">
          <SetupWizard
            settings={settings}
            step={step}
            regions={SES_REGIONS}
            defaultRegion={env.AWS_DEFAULT_REGION}
            oneClickAvailable={env.APP_URL.startsWith("https://")}
            oauthAvailable={cfOauth}
          />
        </div>
      </div>
    </main>
  );
}
