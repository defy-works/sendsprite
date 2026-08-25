import { notFound } from "next/navigation";
import { can } from "@sendsprite/shared";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Link } from "@/components/ui/Link";
import { formatWhen } from "@/lib/format";
import { prepareDetail } from "@/lib/email-detail";
import { requireTeam } from "@/lib/session";
import { loadEnv } from "@/env.schema";
import { listApiKeys } from "@/services/api-keys";
import { listDomains } from "@/services/domains";
import { listEvents, type EmailEvent } from "@/services/email-events";
import { getEmail } from "@/services/emails";
import { EmailActions } from "../EmailActions";
import { EmailDetail, type EventView } from "../EmailDetail";
import { EmailStatusDot } from "../EmailsTable";
import { LiveRefresh } from "../LiveRefresh";

const LABEL: Record<EmailEvent["type"], string> = {
  queued: "Queued",
  sent: "Sent to SES",
  delivered: "Delivered",
  delivery_delayed: "Delivery delayed",
  bounced: "Bounced",
  complained: "Complaint",
  rejected: "Rejected by SES",
  opened: "Opened",
  clicked: "Clicked",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Human lines from the stored payload; unknown shapes fall back to nothing. */
function detailsOf(ev: EmailEvent): string[] {
  const p = ev.payload;
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : null);
  const out: string[] = [];
  const add = (label: string, v: string | null | undefined) =>
    v && out.push(`${label}: ${v}`);
  switch (ev.type) {
    case "queued":
      add("Scheduled for", s("rescheduledTo"));
      break;
    case "sent":
      add("SES message id", s("sesMessageId"));
      if (p.reconciled) out.push("Recorded by the reconciliation sweep");
      break;
    case "delivered":
      add("SMTP response", s("smtpResponse"));
      break;
    case "delivery_delayed":
      add("Delay type", s("delayType"));
      break;
    case "bounced":
      add(
        "Type",
        [s("bounceType"), s("bounceSubType")].filter(Boolean).join(" / "),
      );
      add("Diagnostic", s("diagnosticCode"));
      break;
    case "complained":
      add("Feedback type", s("complaintFeedbackType"));
      break;
    case "rejected":
      add("Reason", s("reason"));
      break;
    case "opened":
      add("User agent", s("userAgent"));
      add("IP", s("ip") ?? s("ipAddress"));
      break;
    case "clicked":
      add("URL", s("url") ?? s("link"));
      add("User agent", s("userAgent"));
      add("IP", s("ip") ?? s("ipAddress"));
      break;
    case "failed":
      add("Error", s("error") ?? s("errorMessage") ?? s("message"));
      add("Code", s("code"));
      break;
    case "cancelled":
      break;
  }
  const rcpt = Array.isArray(p.recipients)
    ? p.recipients.filter((r): r is string => typeof r === "string")
    : [];
  if (rcpt.length) out.push(`Recipients: ${rcpt.join(", ")}`);
  return out;
}

const fmtSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

export default async function EmailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await requireTeam();
  const { id } = await params;
  const e = await getEmail(ctx.team.id, id);
  if (!e) notFound();
  const [events, keys, domains] = await Promise.all([
    listEvents(e.id),
    e.apiKeyId ? listApiKeys(ctx.team.id) : [],
    e.domainId ? listDomains(ctx.team.id) : [],
  ]);
  const key = keys.find((k) => k.id === e.apiKeyId);
  const domain = domains.find((d) => d.id === e.domainId);
  const body = prepareDetail(e, loadEnv().APP_URL);
  const purged = body.purged;
  const inFlight = ["queued", "scheduled", "sending"].includes(e.status);
  const canSend = can(ctx.role, "emails.send");
  const timeline: EventView[] = events.map((ev) => ({
    id: ev.id,
    label: LABEL[ev.type],
    when: formatWhen(ev.occurredAt),
    details: detailsOf(ev),
  }));
  const recipients: [string, string[]][] = [
    ["To", e.to],
    ["Cc", e.cc],
    ["Bcc", e.bcc],
    ["Reply-To", e.replyTo],
  ];
  const facts: [string, string][] = [
    ["Source", e.source],
    [
      "API key",
      key ? `${key.name} (${key.keyPrefix}…)` : e.apiKeyId ? e.apiKeyId : "—",
    ],
    ["Domain", domain?.name ?? "—"],
    ["Created", formatWhen(e.createdAt)],
    ["Scheduled", e.scheduledAt ? formatWhen(e.scheduledAt) : "—"],
    ["Sent", e.sentAt ? formatWhen(e.sentAt) : "—"],
    ["SES message id", e.sesMessageId ?? "—"],
  ];

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <LiveRefresh />
      <div className="flex flex-col gap-2">
        <Link href="/app/emails" className="num-stamp no-underline">
          ← Emails
        </Link>
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="break-words text-lg font-medium">
            {e.subject || "(no subject)"}
          </h1>
          <EmailStatusDot status={e.status} />
        </div>
        <p className="text-sm text-white/70">
          <span className="text-white/50">From</span> {e.from}
        </p>
        {recipients
          .filter(([, list]) => list.length)
          .map(([label, list]) => (
            <p key={label} className="break-all text-sm text-white/70">
              <span className="text-white/50">{label}</span> {list.join(", ")}
            </p>
          ))}
        {Object.keys(e.tags).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {Object.entries(e.tags).map(([k, v]) => (
              <Badge key={k} variant="muted">
                {k}:{v}
              </Badge>
            ))}
          </div>
        )}
        {e.lastError && (
          <p role="alert" className="text-sm text-red-300">
            {e.lastError}
          </p>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {facts.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-white/50">{k}</dt>
                  <dd className="break-all text-white/80">{v}</dd>
                </div>
              ))}
            </dl>
            {e.attachmentsMeta.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1 text-sm">
                {e.attachmentsMeta.map((a) => (
                  <li key={a.id} className="flex justify-between gap-3">
                    <span className="break-all">{a.filename}</span>
                    <span className="shrink-0 text-white/50">
                      {fmtSize(a.size)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        {canSend && (
          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
            </CardHeader>
            <CardBody>
              <EmailActions
                id={e.id}
                cancellable={e.status === "queued" || e.status === "scheduled"}
                resendable={!purged && !inFlight}
              />
            </CardBody>
          </Card>
        )}
      </div>

      <EmailDetail
        html={body.html}
        text={body.text}
        purged={purged}
        headers={e.headers}
        events={timeline}
      />
    </div>
  );
}
