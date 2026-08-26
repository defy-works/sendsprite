import { Card, CardBody } from "@/components/ui/Card";
import { env } from "@/env";
import { SES_REGIONS } from "@/lib/aws/regions";
import { requireTeamAdmin } from "@/lib/session";
import { getTeamAws } from "@/services/team-aws";
import { getTeamSettings } from "@/services/team-settings";
import {
  getTeamCloudflare,
  oauthAvailable,
} from "@/services/cloudflare-connect";
import { AwsStep } from "@/app/setup/steps/AwsStep";
import { ProductionStep } from "@/app/setup/steps/ProductionStep";
import { CloudflareStep } from "@/app/setup/steps/CloudflareStep";
import type { WizardProps, WizardSettings } from "@/app/setup/types";

export const metadata = { title: "Sending" };

export default async function SendingSettingsPage() {
  const ctx = await requireTeamAdmin();
  const [aws, cf, team] = await Promise.all([
    getTeamAws(ctx.team.id),
    getTeamCloudflare(ctx.team.id),
    getTeamSettings(ctx.team.id),
  ]);
  const cfOauth = oauthAvailable();
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
  const props: WizardProps = {
    settings,
    step: "aws",
    regions: SES_REGIONS,
    defaultRegion: env.AWS_DEFAULT_REGION,
    oneClickAvailable: env.APP_URL.startsWith("https://"),
    oauthAvailable: cfOauth,
    mode: "settings",
  };
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Card>
        <CardBody>
          <AwsStep {...props} />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <ProductionStep {...props} />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <CloudflareStep {...props} />
        </CardBody>
      </Card>
    </div>
  );
}
