import Link from "next/link";
import { env } from "@/env";
import { SES_REGIONS } from "@/lib/aws/regions";
import { requireTeamAdmin } from "@/lib/session";
import { getTeamAws } from "@/services/team-aws";
import { getTeamSettings } from "@/services/team-settings";
import {
  getTeamCloudflare,
  oauthAvailable,
} from "@/services/cloudflare-connect";
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
  const ctx = await requireTeamAdmin();
  const [aws, cf, team] = await Promise.all([
    getTeamAws(ctx.team.id),
    getTeamCloudflare(ctx.team.id),
    getTeamSettings(ctx.team.id),
  ]);
  // Only serialisable, non-secret fields cross into the client tree.
  const settings: WizardSettings = {
    awsConnected: aws !== null,
    awsRegion: aws?.region ?? null,
    awsAccountId: aws?.accountId ?? null,
    sesAccountStatus: aws?.sesAccountStatus ?? null,
    sesReviewStatus: aws?.sesReviewStatus ?? null,
    sesDailyQuota: aws?.sesDailyQuota ?? null,
    sesMaxSendRate: aws?.sesMaxSendRate ?? null,
    snsSubscriptionMissing: Boolean(
      aws?.snsTopicArn && !aws.snsSubscriptionArn,
    ),
    cloudflareConnectedAt: cf?.connectedAt?.toISOString() ?? null,
    cloudflareAccountName: cf?.accountName ?? null,
    setupCompleted: team?.setupCompleted ?? false,
  };
  const requested = (await searchParams).step;
  const step: Step = isStep(requested)
    ? requested
    : !settings.awsConnected
      ? "aws"
      : settings.sesAccountStatus !== "production"
        ? "production"
        : !settings.cloudflareConnectedAt
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
            oauthAvailable={oauthAvailable()}
          />
        </div>
      </div>
    </main>
  );
}
