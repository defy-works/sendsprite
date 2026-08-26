import { redirect } from "next/navigation";
import { can } from "@sendsprite/shared";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Link } from "@/components/ui/Link";
import { Notice } from "@/app/setup/steps/shared";
import { requireTeam } from "@/lib/session";
import { getInstanceSettings } from "@/services/instance-settings";
import { DomainForm } from "../DomainForm";

export const metadata = { title: "Add domain" };

export default async function NewDomainPage() {
  const ctx = await requireTeam();
  if (!can(ctx.role, "domains.manage")) redirect("/app/domains");
  const s = await getInstanceSettings();
  return (
    <div className="flex max-w-xl flex-col gap-6">
      {s.awsMode === "none" && (
        <Notice>
          AWS is not connected, so domains cannot be provisioned.{" "}
          {ctx.role === "owner" ? (
            <Link href="/app/settings/instance">Connect AWS in Settings</Link>
          ) : (
            "Ask a team owner to connect it in Settings → Instance."
          )}
        </Notice>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Add a sending domain</CardTitle>
        </CardHeader>
        <CardBody>
          <DomainForm hasCloudflare={Boolean(s.cloudflareConnectedAt)} />
        </CardBody>
      </Card>
    </div>
  );
}
