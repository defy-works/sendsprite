"use client";
import NextLink from "next/link";
import { useState, useTransition } from "react";
import type { CampaignStatus } from "@sendsprite/shared";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { deleteCampaign, type Result } from "./actions";

/** Dates are pre-formatted on the server so SSR and hydration agree. */
export interface CampaignRow {
  id: string;
  name: string;
  status: CampaignStatus;
  /** `null` when the book has been deleted since; see the module comment. */
  bookName: string | null;
  recipients: number;
  sent: string | null;
  scheduled: string | null;
  created: string;
}

/**
 * A full record rather than a lookup with a fallback: a status added to
 * `CAMPAIGN_STATUSES` later is a typecheck error here, not a badge that
 * silently renders in the default colour.
 */
const STATUS_VARIANT: Record<CampaignStatus, BadgeVariant> = {
  draft: "muted",
  scheduled: "indigo",
  sending: "warning",
  sent: "success",
  cancelled: "danger",
};

/** What the "when" column says, which depends on how far along the send is. */
function when(c: CampaignRow): string {
  if (c.sent) return `Sent ${c.sent}`;
  if (c.status === "sending") return "Sending now";
  if (c.scheduled) return `Scheduled ${c.scheduled}`;
  return `Created ${c.created}`;
}

export function CampaignList({
  campaigns,
  canManage,
  hasBook,
}: {
  campaigns: CampaignRow[];
  canManage: boolean;
  /** Without a contact book there is no audience, so no campaign to make. */
  hasBook: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const remove = (c: CampaignRow) => {
    // Honest about what a delete does and does not undo: the `emails` rows
    // stay in the mail log, because deleting a campaign is "stop listing
    // this", not "forget having mailed anyone".
    const warning =
      c.status === "sent" || c.status === "cancelled"
        ? `Delete "${c.name}"? Its stats and body go; the messages already sent stay in the mail log.`
        : `Delete "${c.name}"?`;
    if (!window.confirm(warning)) return;
    start(async () => {
      setError(null);
      try {
        const res: Result = await deleteCampaign(c.id);
        if (!res.ok) setError(res.error);
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  if (campaigns.length === 0)
    return (
      <EmptyState
        title="No campaigns yet"
        body={
          !hasBook
            ? "A campaign mails everyone in a contact book, so it needs a book first. Create one, add contacts, then come back."
            : canManage
              ? "Compose a body out of headings, text, buttons and images, pick a book, and send it to everyone in that book who is subscribed and not suppressed."
              : "A campaign is one designed email sent to a whole contact book. Ask an admin to create one."
        }
        action={
          !hasBook ? (
            <Button asChild>
              <NextLink href="/app/contacts">Create a contact book</NextLink>
            </Button>
          ) : canManage ? (
            <Button asChild>
              <NextLink href="/app/campaigns/new">New campaign</NextLink>
            </Button>
          ) : undefined
        }
      />
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="glass overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="num-stamp text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Book</th>
              <th className="px-4 py-3 font-medium">Recipients</th>
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id} className="border-t border-white/8">
                <td className="px-4 py-3 font-medium">
                  <NextLink
                    href={`/app/campaigns/${c.id}`}
                    className="underline decoration-white/30 underline-offset-2 hover:text-white"
                  >
                    {c.name}
                  </NextLink>
                </td>
                <td className="px-4 py-3">
                  <Badge variant={STATUS_VARIANT[c.status]}>{c.status}</Badge>
                </td>
                <td className="px-4 py-3 text-white/65">
                  {c.bookName ?? (
                    <span
                      className="text-amber-300"
                      title="The contact book this campaign was drawn from has been deleted."
                    >
                      Book deleted
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 tabular-nums text-white/65">
                  {c.recipients.toLocaleString("en-US")}
                </td>
                <td className="px-4 py-3 text-white/65">{when(c)}</td>
                <td className="px-4 py-3 text-right">
                  {canManage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      // A campaign mid-fan-out cannot be deleted — the sweep
                      // would go on materialising rows for a row that is
                      // gone. Disabled with the reason rather than offered
                      // and then refused.
                      disabled={pending || c.status === "sending"}
                      title={
                        c.status === "sending"
                          ? "Cancel it before deleting."
                          : undefined
                      }
                      onClick={() => remove(c)}
                    >
                      Delete
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
