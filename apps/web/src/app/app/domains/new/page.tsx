import { redirect } from "next/navigation";
import { can } from "@sendsprite/shared";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Link } from "@/components/ui/Link";
import { Notice } from "@/app/setup/steps/shared";
import { requireTeam } from "@/lib/session";
import { getTeamAws } from "@/services/team-aws";
import { getTeamCloudflare } from "@/services/cloudflare-connect";
import { DomainForm } from "../DomainForm";

export const metadata = { title: "Add domain" };

export default async function NewDomainPage() {
  const ctx = await requireTeam();
  if (!can(ctx.role, "domains.manage")) redirect("/app/domains");
  const [aws, cf] = await Promise.all([
    getTeamAws(ctx.team.id),
    getTeamCloudflare(ctx.team.id),
  ]);
  return (
    <div className="flex max-w-xl flex-col gap-6">
      {!aws && (
        <Notice>
          AWS is not connected, so domains cannot be provisioned.{" "}
          {ctx.role === "owner" || ctx.role === "admin" ? (
            <Link href="/app/settings#sending">Connect AWS in Settings</Link>
          ) : (
            "Ask a team owner or admin to connect it in Settings → Sending."
          )}
        </Notice>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Add a sending domain</CardTitle>
        </CardHeader>
        <CardBody>
          <DomainForm hasCloudflare={cf !== null} />
        </CardBody>
      </Card>
    </div>
  );
}
