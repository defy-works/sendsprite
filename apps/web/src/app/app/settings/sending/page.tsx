import { notFound } from "next/navigation";
import { env } from "@/env";
import { SES_REGIONS } from "@/lib/aws/regions";
import { requireTeam } from "@/lib/session";
import {
  getTeamCloudflare,
  oauthAvailable,
} from "@/services/cloudflare-connect";
import { getTeamAws } from "@/services/team-aws";
import { getTeamSettings } from "@/services/team-settings";
import { Card, CardBody } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { AwsStep } from "@/app/setup/steps/AwsStep";
import { ProductionStep } from "@/app/setup/steps/ProductionStep";
import { CloudflareStep } from "@/app/setup/steps/CloudflareStep";
import type { WizardProps, WizardSettings } from "@/app/setup/types";

export const metadata = { title: "Sending" };

/**
 * Where this team's mail goes out from: its AWS account, its SES standing and
 * its Cloudflare grant.
 *
 * A real page again. It was a redirect into `/app/settings#sending` while
 * Settings was one long scroll; the sections are separate routes now, so the
 * path this was always linked from — the dashboard banner, the setup wizard,
 * the Cloudflare OAuth `from` parameter, and whatever anyone bookmarked —
 * lands on the thing itself.
 *
 * Admin only, and the connection is never read for anyone else: a member has
 * no business seeing which AWS account a team is wired to, and the sidebar
 * does not offer them the row.
 */
export default async function SendingSettingsPage() {
  const ctx = await requireTeam();
  if (ctx.role !== "owner" && ctx.role !== "admin") notFound();

  const [settings, aws, cf] = await Promise.all([
    getTeamSettings(ctx.team.id),
    getTeamAws(ctx.team.id),
    getTeamCloudflare(ctx.team.id),
  ]);

  const cfOauth = oauthAvailable();
  const sending: WizardProps = {
    // Only serialisable, non-secret fields cross into the client tree.
    settings: {
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
      setupCompleted: settings?.setupCompleted ?? false,
    } satisfies WizardSettings,
    step: "aws",
    regions: SES_REGIONS,
    defaultRegion: env.AWS_DEFAULT_REGION,
    oneClickAvailable: env.APP_URL.startsWith("https://"),
    oauthAvailable: cfOauth,
    mode: "settings",
  };

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <PageHeader
        title="Sending"
        description="This team sends through its own AWS account. Nothing here is shared with any other team on this instance."
      />
      <Card>
        <CardBody>
          <AwsStep {...sending} />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <ProductionStep {...sending} />
        </CardBody>
      </Card>
      {/* Rendered only when this instance has an OAuth client: the
          registration steps are an operator's job and live at /admin. */}
      {cfOauth && (
        <Card>
          <CardBody>
            <CloudflareStep {...sending} />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
