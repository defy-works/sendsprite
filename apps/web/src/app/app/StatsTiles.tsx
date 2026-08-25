import { Card } from "@/components/ui/Card";
import { StatusDot, type Status } from "@/components/ui/StatusDot";
import { THRESHOLDS, type SendStats, type StatsAlert } from "@/services/stats";

const pct = (r: number) =>
  `${(r * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const level = (alerts: StatsAlert[], kind: StatsAlert["kind"]): Status => {
  const a = alerts.find((x) => x.kind === kind);
  return a?.level === "critical" ? "error" : a ? "warning" : "ok";
};

export function StatsTiles({ stats }: { stats: SendStats }) {
  const sent: [string, number][] = [
    ["Sent · 24 h", stats.sent.today],
    ["Sent · 7 d", stats.sent.d7],
    ["Sent · 30 d", stats.sent.d30],
  ];
  const rates: [string, number, Status][] = [
    ["Delivered · 30 d", stats.rates.delivered, "ok"],
    ["Bounced · 30 d", stats.rates.bounced, level(stats.alerts, "bounce")],
    [
      "Complained · 30 d",
      stats.rates.complained,
      level(stats.alerts, "complaint"),
    ],
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {sent.map(([label, n]) => (
        <Card key={label} className="flex flex-col gap-2">
          <p className="num-stamp">{label}</p>
          <p className="metric-xl">{n.toLocaleString("en-US")}</p>
        </Card>
      ))}
      {rates.map(([label, r, status]) => (
        <Card key={label} className="flex flex-col gap-2">
          <StatusDot status={status} label={label} />
          <p className="text-2xl font-semibold tabular-nums">{pct(r)}</p>
        </Card>
      ))}
    </div>
  );
}

const WORDING: Record<StatsAlert["kind"], string> = {
  bounce: `SES suspends sending at a 10% bounce rate and reviews accounts from 5%. Keep it under ${pct(THRESHOLDS.bounce.warning)}.`,
  complaint: `SES suspends sending at a 0.5% complaint rate and reviews accounts from 0.1%. Keep it under ${pct(THRESHOLDS.complaint.warning)}.`,
};

export function AlertBanners({
  alerts,
  scope,
}: {
  alerts: StatsAlert[];
  scope: "team" | "instance";
}) {
  if (!alerts.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {alerts.map((a) => (
        <p
          key={a.kind}
          role="alert"
          className={
            a.level === "critical"
              ? "rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200"
              : "rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200"
          }
        >
          <strong>
            {scope === "instance" ? "Instance-wide " : ""}
            {a.kind} rate {pct(a.rate)}
          </strong>{" "}
          over the last {a.window}. {WORDING[a.kind]}
        </p>
      ))}
    </div>
  );
}
