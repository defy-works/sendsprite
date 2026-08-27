import { notFound } from "next/navigation";
import { can } from "@sendsprite/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { IconDownload } from "@/components/ui/icons";
import { StatusDot, type Status } from "@/components/ui/StatusDot";
import { cloudflareDnsUrl } from "@/lib/dns/cloudflare-zone";
import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { getDomain, type Domain } from "@/services/domains";
import { Alert } from "@/app/setup/steps/shared";
import { ApplyDns } from "../ApplyDns";
import { DomainActions } from "../DomainActions";
import { DomainPoller } from "../DomainPoller";
import { RecordsTable } from "../RecordsTable";
import { PageHeader } from "@/components/ui/PageHeader";

const DOT: Record<Domain["status"], Status> = {
  pending: "pending",
  verified: "ok",
  failed: "error",
};

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
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: "/app/domains", label: "Domains" }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {d.name}
            <StatusDot status={DOT[d.status]} label={d.status} />
            <Badge variant={d.dnsMode === "auto" ? "indigo" : "muted"}>
              {d.dnsMode === "auto" ? "Cloudflare" : "manual DNS"}
            </Badge>
          </span>
        }
        description={`${d.region} · last checked ${formatWhen(d.lastCheckedAt)}`}
      />
      {d.lastError && <Alert>{d.lastError}</Alert>}
      <DomainPoller provisioned={d.dkimTokens.length > 0} status={d.status} />
      <Card>
        <CardHeader>
          <CardTitle>DNS records</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <p className="text-sm text-white/65">
            {d.dnsMode === "auto"
              ? "SES issued these records. Apply writes them to your Cloudflare zone; SES confirms DKIM and MAIL FROM once DNS propagates, and we re-check every 2 minutes for 72 hours."
              : "Add these at your DNS provider. We re-check every 2 minutes for 72 hours; click Re-verify to check right away."}
          </p>
          {d.dnsMode === "auto" &&
            d.dkimTokens.length > 0 &&
            can(ctx.role, "domains.manage") && (
              <ApplyDns
                id={d.id}
                zone={d.cloudflareZone}
                appliedAt={d.dnsAppliedAt?.toISOString() ?? null}
              />
            )}
          {d.dnsMode === "manual" && d.cloudflareZone && (
            <p className="text-sm text-white/65">
              <strong>{d.cloudflareZone}</strong> is on Cloudflare.{" "}
              <a
                className="text-indigo-300 underline"
                href={cloudflareDnsUrl(d.cloudflareZone)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open its DNS records
              </a>{" "}
              and add the rows below.
            </p>
          )}
          <RecordsTable records={d.expectedRecords} />
          {d.dkimTokens.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="subtle" asChild icon={<IconDownload />}>
                {/* A plain anchor, not next/link: this is a file download from a
                    route handler, not a client navigation. `download` lets the
                    browser save it instead of navigating to it. */}
                <a href={`/app/domains/${d.id}/zone`} download>
                  Download BIND zone file
                </a>
              </Button>
              <span className="text-sm text-white/50">
                Every record above, in one file to upload at your DNS provider.
              </span>
            </div>
          )}
        </CardBody>
      </Card>
      {can(ctx.role, "domains.manage") && (
        <Card>
          <CardHeader>
            <CardTitle>Actions</CardTitle>
          </CardHeader>
          <CardBody>
            <DomainActions
              id={d.id}
              name={d.name}
              provisioned={d.dkimTokens.length > 0}
              retryable={d.dkimTokens.length === 0 && !!d.lastError}
            />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
