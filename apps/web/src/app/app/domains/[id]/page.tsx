import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Link } from "@/components/ui/Link";
import { StatusDot, type Status } from "@/components/ui/StatusDot";
import { requireTeam } from "@/lib/session";
import { getDomain, type Domain } from "@/services/domains";
import { Alert } from "@/app/setup/steps/shared";
import { DomainActions } from "../DomainActions";
import { RecordsTable } from "../RecordsTable";

const DOT: Record<Domain["status"], Status> = {
  pending: "pending",
  verified: "ok",
  failed: "error",
};

const formatWhen = (d: Date | null) =>
  d
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      }).format(d) + " UTC"
    : "never";

export default async function DomainPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await requireTeam();
  const { id } = await params;
  const d = await getDomain(ctx.team.id, id);
  if (!d) notFound();
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/app/domains" className="num-stamp no-underline">
          ← Domains
        </Link>
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-lg font-medium">{d.name}</h1>
          <StatusDot status={DOT[d.status]} label={d.status} />
          <Badge variant={d.dnsMode === "auto" ? "indigo" : "muted"}>
            {d.dnsMode === "auto" ? "Cloudflare auto" : "manual DNS"}
          </Badge>
          <span className="text-sm text-white/50">
            {d.region} · last checked {formatWhen(d.lastCheckedAt)}
          </span>
        </div>
      </div>
      {d.lastError && <Alert>{d.lastError}</Alert>}
      <Card>
        <CardHeader>
          <CardTitle>DNS records</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <p className="text-sm text-white/65">
            {d.dnsMode === "auto"
              ? "These records were written to your Cloudflare zone. SES confirms DKIM and MAIL FROM once DNS propagates; we re-check every 2 minutes for 72 hours."
              : "Add these at your DNS provider. We re-check every 2 minutes for 72 hours; click Re-verify to check right away."}
          </p>
          <RecordsTable records={d.expectedRecords} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardBody>
          <DomainActions id={d.id} name={d.name} status={d.status} />
        </CardBody>
      </Card>
    </div>
  );
}
