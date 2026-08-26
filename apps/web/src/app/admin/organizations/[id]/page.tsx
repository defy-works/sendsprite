import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusDot } from "@/components/ui/StatusDot";
import { requireInstanceAdmin } from "@/lib/session";
import { getOrganization } from "@/services/admin";
import { getInstanceSettings } from "@/services/instance-settings";
import { OverridesForm } from "./OverridesForm";
import { SuspendPanel } from "./SuspendPanel";

const date = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(d);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const org = await getOrganization((await params).id);
  return { title: org ? org.name : "Organization" };
}

export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireInstanceAdmin();
  const { id } = await params;
  const [org, instance] = await Promise.all([
    getOrganization(id),
    getInstanceSettings(),
  ]);
  if (!org) notFound();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: "/admin/organizations", label: "Organizations" }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {org.name}
            {org.suspendedAt && <Badge variant="danger">Suspended</Badge>}
            {!org.setupCompleted && (
              <Badge variant="muted">Setup unfinished</Badge>
            )}
          </span>
        }
        description={`${org.slug} · created ${date(org.createdAt)}`}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Connection</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            <StatusDot
              status={org.awsConnected ? "ok" : "error"}
              label={
                org.awsConnected
                  ? `AWS ${org.awsAccountId ?? "account unknown"} · ${org.awsRegion}`
                  : "AWS not connected"
              }
            />
            <StatusDot
              status={
                org.sesStatus === "production"
                  ? "ok"
                  : org.sesStatus === "requested"
                    ? "pending"
                    : org.sesStatus === "sandbox"
                      ? "warning"
                      : "off"
              }
              label={
                org.sesStatus
                  ? `SES ${org.sesStatus}${
                      org.sesDailyQuota != null
                        ? ` · ${org.sesDailyQuota.toLocaleString("en-US")}/day · ${org.sesMaxSendRate ?? "?"}/s`
                        : ""
                    }`
                  : "SES status unknown"
              }
            />
            <StatusDot
              status={org.cloudflareConnected ? "ok" : "off"}
              label={
                org.cloudflareConnected
                  ? `Cloudflare · ${org.cloudflareAccountName ?? "connected"}`
                  : "Cloudflare not connected (manual DNS)"
              }
            />
            {/* Credentials are never rendered, not even redacted. This page
                exists to let an operator diagnose a tenant, and no diagnosis
                needs the tenant's AWS secret on screen. */}
            <p className="pt-1 text-xs text-white/40">
              This team&apos;s AWS credentials are encrypted at rest and are not
              readable from here.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Usage</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <Row
                label="Members"
                value={org.members.toLocaleString("en-US")}
              />
              <Row
                label="Domains"
                value={org.domains.toLocaleString("en-US")}
              />
              <Row
                label="Sent · 30d"
                value={org.sent30d.toLocaleString("en-US")}
              />
              <Row label="Plan" value={org.plan ?? "free"} />
            </dl>
            <ul className="mt-4 flex flex-col gap-1.5 border-t border-white/8 pt-3 text-sm">
              {org.people.map((p) => (
                <li key={p.userId} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-white/75">
                    {p.name || p.email}
                  </span>
                  {p.instanceAdmin && (
                    <Badge variant="indigo">Instance admin</Badge>
                  )}
                  <Badge variant={p.role === "owner" ? "indigo" : "muted"}>
                    {p.role}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Overrides</CardTitle>
        </CardHeader>
        <CardBody>
          <OverridesForm
            teamId={org.id}
            dailyLimit={org.dailyLimit}
            monthlyLimit={org.monthlyLimit}
            retentionDays={org.retentionDays}
            instanceRetentionMax={instance.retentionDays}
          />
        </CardBody>
      </Card>

      <div className="rounded-lg border border-danger/35 bg-danger/6 p-5">
        <SuspendPanel
          teamId={org.id}
          teamName={org.name}
          suspendedAt={org.suspendedAt?.toISOString() ?? null}
          suspendedReason={org.suspendedReason}
        />
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="num-stamp">{label}</dt>
      <dd className="tnum text-white/85">{value}</dd>
    </div>
  );
}
