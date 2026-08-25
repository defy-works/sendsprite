import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { requireTeam } from "@/lib/session";
import { getInstanceSettings } from "@/services/instance-settings";
import { DomainForm } from "../DomainForm";

export const metadata = { title: "Add domain" };

export default async function NewDomainPage() {
  await requireTeam();
  const s = await getInstanceSettings();
  return (
    <div className="max-w-xl">
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
