import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { env } from "@/env";
import { SES_REGIONS } from "@/lib/aws/regions";
import { requireOwner } from "@/lib/session";
import { getInstanceSettings } from "@/services/instance-settings";
import { oauthAvailable } from "@/services/cloudflare-connect";
import { AwsStep } from "@/app/setup/steps/AwsStep";
import { ProductionStep } from "@/app/setup/steps/ProductionStep";
import { CloudflareStep } from "@/app/setup/steps/CloudflareStep";
import type { WizardProps, WizardSettings } from "@/app/setup/types";
import { InstanceForm } from "./InstanceForm";

export const metadata = { title: "Instance settings" };

export default async function InstanceSettingsPage() {
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
      <Card>
        <CardHeader>
          <CardTitle>Instance</CardTitle>
        </CardHeader>
        <CardBody>
          <InstanceForm
            signupMode={s.signupMode ?? "auto"}
            landingEnabled={s.landingEnabled ?? true}
            retentionDays={s.retentionDays}
            envSignupMode={env.SIGNUP_MODE}
          />
        </CardBody>
      </Card>
    </div>
  );
}
