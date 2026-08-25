import NextLink from "next/link";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { StatusDot } from "@/components/ui/StatusDot";
import { requireTeam } from "@/lib/session";
import { listDomains } from "@/services/domains";
import { getInstanceSettings } from "@/services/instance-settings";

export default async function OverviewPage() {
  const ctx = await requireTeam();
  const [s, domains] = await Promise.all([
    getInstanceSettings(),
    listDomains(ctx.team.id),
  ]);
  // Instance-level steps link only for owners (the page requires it).
  const instance = ctx.role === "owner" ? "/app/settings/instance" : null;
  const steps = [
    { label: "Connect AWS", done: s.awsMode !== "none", href: instance },
    {
      label: "Connect Cloudflare (optional)",
      done: Boolean(s.cloudflareTokenEnc),
      href: instance,
    },
    {
      label: "Add a sending domain",
      done: domains.some((d) => d.status === "verified"),
      href: "/app/domains",
    },
    { label: "Create an API key", done: false, href: null },
    { label: "Send your first email", done: false, href: null },
  ];
  return (
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
          <CardTitle>Team</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-white/70">
            {ctx.team.name} · you are <strong>{ctx.role}</strong>
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
