import type { EmailStatus } from "@sendsprite/shared";
import { EmptyState } from "@/components/ui/EmptyState";
import { Link } from "@/components/ui/Link";
import { StatusDot, type Status } from "@/components/ui/StatusDot";
import { formatWhen } from "@/lib/format";
import type { EmailRow } from "@/services/emails";

/** Dates are pre-formatted on the server so SSR and hydration agree. */
export interface EmailListRow {
  id: string;
  to: string[];
  subject: string;
  status: EmailStatus;
  domain: string | null;
  created: string;
  sent: string;
}

const DOT: Record<EmailStatus, Status> = {
  queued: "pending",
  scheduled: "pending",
  sending: "pending",
  sent: "ok",
  delivered: "ok",
  bounced: "error",
  complained: "error",
  failed: "error",
  cancelled: "off",
};

export const EmailStatusDot = ({ status }: { status: EmailStatus }) => (
  <StatusDot status={DOT[status]} label={status} />
);

export const toListRow = (
  e: EmailRow,
  domainName: (id: string | null) => string | null,
): EmailListRow => ({
  id: e.id,
  to: e.to,
  subject: e.subject,
  status: e.status,
  domain: domainName(e.domainId),
  created: formatWhen(e.createdAt),
  sent: e.sentAt ? formatWhen(e.sentAt) : "—",
});

export function EmailsTable({
  emails,
  emptyBody,
}: {
  emails: EmailListRow[];
  emptyBody?: string;
}) {
  if (emails.length === 0)
    return (
      <EmptyState
        title="No emails yet"
        body={
          emptyBody ??
          "Emails sent through the API or SMTP relay show up here as they are queued, sent and delivered."
        }
      />
    );
  return (
    <div className="glass overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="num-stamp text-left">
          <tr>
            <th className="px-4 py-3 font-medium">To</th>
            <th className="px-4 py-3 font-medium">Subject</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Domain</th>
            <th className="px-4 py-3 font-medium">Created</th>
            <th className="px-4 py-3 font-medium">Sent</th>
          </tr>
        </thead>
        <tbody>
          {emails.map((e) => (
            <tr key={e.id} className="border-t border-white/8">
              <td
                className="max-w-xs truncate px-4 py-3"
                title={e.to.join(", ")}
              >
                {e.to[0]}
                {e.to.length > 1 && (
                  <span className="text-white/50"> +{e.to.length - 1}</span>
                )}
              </td>
              <td className="max-w-sm truncate px-4 py-3">
                <Link href={`/app/emails/${e.id}`}>
                  {e.subject || "(no subject)"}
                </Link>
              </td>
              <td className="px-4 py-3">
                <EmailStatusDot status={e.status} />
              </td>
              <td className="px-4 py-3 text-white/65">{e.domain ?? "—"}</td>
              <td className="whitespace-nowrap px-4 py-3 text-white/65">
                {e.created}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-white/65">
                {e.sent}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
