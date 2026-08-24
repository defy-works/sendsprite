import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { StatusDot } from "@/components/ui/StatusDot";
import { requireTeam } from "@/lib/session";
import { getInstanceSettings } from "@/services/instance-settings";

export default async function OverviewPage() {
  const ctx = await requireTeam();
  const s = await getInstanceSettings();
  const steps = [
    { label: "Connect AWS", done: s.awsMode !== "none" },
    {
      label: "Connect Cloudflare (optional)",
      done: Boolean(s.cloudflareTokenEnc),
    },
    { label: "Add a sending domain", done: false },
    { label: "Create an API key", done: false },
    { label: "Send your first email", done: false },
  ];
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Setup checklist</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-2">
          {steps.map((st) => (
            <StatusDot
              key={st.label}
              status={st.done ? "ok" : "off"}
              label={st.label}
            />
          ))}
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
