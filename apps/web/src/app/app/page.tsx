import NextLink from "next/link";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Link } from "@/components/ui/Link";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusDot } from "@/components/ui/StatusDot";
import {
  IconArrowRight,
  IconCheck,
  IconGlobe,
  IconMegaphone,
  IconSend,
} from "@/components/ui/icons";
import { requireTeam } from "@/lib/session";
import { listApiKeys } from "@/services/api-keys";
import { listDomains } from "@/services/domains";
import { listEmails } from "@/services/emails";
import { getTeamAws } from "@/services/team-aws";
import { getTeamCloudflare } from "@/services/cloudflare-connect";
import { oauthAvailable } from "@/services/cloudflare-connect";
import { teamStats } from "@/services/stats";
import { EmailsTable, toListRow } from "./emails/EmailsTable";
import { LiveRefresh } from "./emails/LiveRefresh";
import { AlertBanners, StatsTiles } from "./StatsTiles";

export default async function OverviewPage() {
  const ctx = await requireTeam();
  const canConfigure = ctx.role === "owner" || ctx.role === "admin";
  const [aws, cf, domains, keys, recent, stats] = await Promise.all([
    getTeamAws(ctx.team.id),
    getTeamCloudflare(ctx.team.id),
    listDomains(ctx.team.id),
    listApiKeys(ctx.team.id),
    listEmails(ctx.team.id, { limit: 10 }),
    teamStats(ctx.team.id),
    // `instanceStats()` used to be read here for owners and shown as an
    // "instance-wide bounce rate" banner. It aggregates every team on the
    // deployment, and every team now sends from its own AWS account with its
    // own SES reputation — so it leaked one tenant's deliverability signal to
    // another *and* told this team about a problem that is not theirs and
    // that they cannot act on. Instance-wide health belongs at /admin, behind
    // `requireInstanceAdmin`, and that is where it is.
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

  // Connection steps link only for those who may change them: owner *or*
  // admin, which is who `requireTeamAdmin` lets into Sending. It read `owner`
  // alone, so an admin saw a checklist of dead text.
  const sendingHref = canConfigure ? "/app/settings/sending" : null;
  const steps = [
    { label: "Connect AWS", done: aws !== null, href: sendingHref },
    // Only offered when the instance can actually do it; otherwise it is a
    // permanently unticked box for something nobody here can turn on.
    ...(oauthAvailable()
      ? [
          {
            label: "Connect Cloudflare (optional)",
            done: cf !== null,
            href: sendingHref,
          },
        ]
      : []),
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
  const remaining = steps.filter((s) => !s.done).length;

  return (
    <div className="flex flex-col gap-6">
      <LiveRefresh />
      <PageHeader
        eyebrow={ctx.team.name}
        title="Overview"
        description={`Signed in as ${ctx.role}. The last 30 days of sending, and what is left to set up.`}
        actions={
          <>
            <Button asChild variant="subtle">
              <NextLink href="/app/domains/new">
                <IconGlobe />
                Add a domain
              </NextLink>
            </Button>
            <Button asChild>
              <NextLink href="/app/campaigns/new">
                <IconMegaphone />
                New campaign
              </NextLink>
            </Button>
          </>
        }
      />
      <AlertBanners alerts={stats.alerts} />
      <StatsTiles stats={stats} />
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Setup checklist</CardTitle>
            <span className="text-xs text-white/45">
              {remaining === 0
                ? "All done"
                : `${remaining} left of ${steps.length}`}
            </span>
          </CardHeader>
          <CardBody className="-mx-2 flex flex-col">
            {steps.map((st) => {
              const inner = (
                <>
                  <span
                    aria-hidden
                    className={
                      st.done
                        ? "flex h-5 w-5 items-center justify-center rounded-full bg-success/20 text-[11px] text-green-300"
                        : "flex h-5 w-5 items-center justify-center rounded-full border border-white/15 text-[11px] text-white/25"
                    }
                  >
                    {st.done ? <IconCheck /> : null}
                  </span>
                  <span
                    className={
                      st.done
                        ? "flex-1 text-sm text-white/45 line-through"
                        : "flex-1 text-sm text-white/85"
                    }
                  >
                    {st.label}
                  </span>
                  {st.href && !st.done && (
                    <IconArrowRight className="text-xs text-white/30 transition-transform group-hover:translate-x-0.5 group-hover:text-indigo-300" />
                  )}
                </>
              );
              return st.href ? (
                <NextLink
                  key={st.label}
                  href={st.href}
                  className="group flex items-center gap-2.5 rounded-md px-2 py-2 no-underline transition-colors hover:bg-white/6"
                >
                  {inner}
                </NextLink>
              ) : (
                <div
                  key={st.label}
                  className="flex items-center gap-2.5 px-2 py-2"
                >
                  {inner}
                </div>
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
            {domains.length === 0 && (
              <p className="pt-2 text-sm text-white/60">
                Nothing can be sent until a domain is verified. It takes one DNS
                change and a few minutes.
              </p>
            )}
          </CardBody>
        </Card>
      </div>
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="num-stamp flex items-center gap-2">
            <IconSend className="text-sm" />
            Recent emails
          </h2>
          <Link href="/app/emails" className="text-xs">
            View all
          </Link>
        </div>
        <EmailsTable emails={rows} />
      </section>
    </div>
  );
}
