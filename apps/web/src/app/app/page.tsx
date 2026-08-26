import NextLink from "next/link";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Link } from "@/components/ui/Link";
import { StatusDot } from "@/components/ui/StatusDot";
import { requireTeam } from "@/lib/session";
import { listApiKeys } from "@/services/api-keys";
import { listDomains } from "@/services/domains";
import { listEmails } from "@/services/emails";
import { getTeamAws } from "@/services/team-aws";
import { getTeamCloudflare } from "@/services/cloudflare-connect";
import { instanceStats, teamStats } from "@/services/stats";
import { EmailsTable, toListRow } from "./emails/EmailsTable";
import { LiveRefresh } from "./emails/LiveRefresh";
import { AlertBanners, StatsTiles } from "./StatsTiles";

export default async function OverviewPage() {
  const ctx = await requireTeam();
  const owner = ctx.role === "owner";
  const [aws, cf, domains, keys, recent, stats, instance] = await Promise.all([
    getTeamAws(ctx.team.id),
    getTeamCloudflare(ctx.team.id),
    listDomains(ctx.team.id),
    listApiKeys(ctx.team.id),
    listEmails(ctx.team.id, { limit: 10 }),
    teamStats(ctx.team.id),
    owner ? instanceStats() : null,
  ]);
  const byId = new Map(domains.map((d) => [d.id, d.name]));
  const recentRows = recent.ok ? recent.data.data : [];
  const rows = recentRows.map((e) =>
    toListRow(e, (id) => (id ? (byId.get(id) ?? null) : null)),
  );
  const health = {
    verified: domains.filter((d) => d.status === "verified").length,
    pending: domains.filter((d) => d.status === "pending").length,
    failed: domains.filter((d) => d.status === "failed").length,
  };
  // Connection steps link only for those who may change them.
  const sendingHref = owner ? "/app/settings/sending" : null;
  const steps = [
    { label: "Connect AWS", done: aws !== null, href: sendingHref },
    {
      label: "Connect Cloudflare (optional)",
      done: cf !== null,
      href: sendingHref,
    },
    {
      label: "Add a sending domain",
      done: health.verified > 0,
      href: "/app/domains",
    },
    {
      label: "Create an API key",
      done: keys.length > 0,
      href: "/app/api-keys",
    },
    {
      label: "Send your first email",
      done: recentRows.length > 0,
      href: "/app/emails",
    },
  ];
  return (
    <div className="flex flex-col gap-6">
      <LiveRefresh />
      {instance && <AlertBanners alerts={instance.alerts} scope="instance" />}
      <AlertBanners alerts={stats.alerts} scope="team" />
      <StatsTiles stats={stats} />
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Setup checklist</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            {steps.map((st) => {
              const dot = (
                <StatusDot status={st.done ? "ok" : "off"} label={st.label} />
              );
              return st.href ? (
                <NextLink
                  key={st.label}
                  href={st.href}
                  className="rounded-md transition-colors hover:bg-white/6"
                >
                  {dot}
                </NextLink>
              ) : (
                <div key={st.label}>{dot}</div>
              );
            })}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Domains</CardTitle>
            <Link href="/app/domains" className="text-xs">
              Manage
            </Link>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            <StatusDot status="ok" label={`${health.verified} verified`} />
            <StatusDot
              status={health.pending ? "pending" : "off"}
              label={`${health.pending} pending`}
            />
            <StatusDot
              status={health.failed ? "error" : "off"}
              label={`${health.failed} failed`}
            />
            <p className="pt-2 text-sm text-white/70">
              {ctx.team.name} · you are <strong>{ctx.role}</strong>
            </p>
          </CardBody>
        </Card>
      </div>
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="num-stamp">Recent emails</h2>
          <Link href="/app/emails" className="text-xs">
            View all
          </Link>
        </div>
        <EmailsTable emails={rows} />
      </section>
    </div>
  );
}
