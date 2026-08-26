import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { env } from "@/env";
import { requireInstanceAdmin } from "@/lib/session";
import { getInstanceSettings } from "@/services/instance-settings";
import { InstanceForm } from "./InstanceForm";

export const metadata = { title: "Instance admin" };

export default async function AdminPage() {
  await requireInstanceAdmin();
  const s = await getInstanceSettings();
  return (
    <div className="flex max-w-3xl flex-col gap-6">
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
