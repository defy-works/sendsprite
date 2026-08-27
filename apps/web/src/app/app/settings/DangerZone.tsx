"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { IconTrash } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { deleteTeamAction } from "./actions";

/**
 * Deleting the team.
 *
 * Owner only, and gated on typing the team's name — the one confirmation in
 * this product that a reflexive click must not be able to get through. What
 * the copy owes the owner is the list of what actually goes, because "this
 * cannot be undone" says nothing about scope: the contact books and the mail
 * log are the two people are surprised by.
 */
export function DangerZone({
  teamName,
  isOwner,
  memberCount,
}: {
  teamName: string;
  isOwner: boolean;
  memberCount: number;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!isOwner)
    return (
      <p className="text-sm text-white/60">
        Only the team owner can delete this team.
      </p>
    );

  const remove = async () => {
    const ok = await confirm({
      title: `Delete "${teamName}"?`,
      body: "Domains, contacts, campaigns, templates, API keys, webhooks and the whole mail log go with it, for everyone on the team. The SES identities and DNS records this team created in your own AWS and Cloudflare accounts are removed too.",
      confirmLabel: "Delete this team",
      tone: "danger",
      typeToConfirm: teamName,
      // The name itself is rendered by the dialog, below this label, in its
      // real casing — this label is uppercased by its own styling and would
      // lie about it.
      typeToConfirmLabel: "Type the team name below to confirm",
    });
    if (!ok) return;
    start(async () => {
      setError(null);
      try {
        const res = await deleteTeamAction();
        if (!res.ok) return setError(res.error);
        const { leftoverDnsRecords, awsLeftovers, domainsWithLeftovers } =
          res.data;
        if (leftoverDnsRecords > 0 || awsLeftovers)
          toast({
            tone: "error",
            title: `${teamName} deleted, with leftovers`,
            body: [
              domainsWithLeftovers > 0 &&
                `${leftoverDnsRecords} DNS record(s) across ${domainsWithLeftovers} domain(s) could not be removed.`,
              awsLeftovers &&
                "The SES configuration set and SNS topic are still in your AWS account.",
              "Remove them by hand.",
            ]
              .filter(Boolean)
              .join(" "),
          });
        else toast({ tone: "success", title: `${teamName} deleted` });
        // Not `router.refresh()`: the layout this component is inside belongs
        // to a team that no longer exists. A push re-runs it against whatever
        // team resolves next, or lands on /teams/new when there is none.
        router.push("/app");
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-white/70">
        Deleting <strong>{teamName}</strong> removes it for all{" "}
        {memberCount === 1 ? "1 member" : `${memberCount} members`} and cannot
        be undone. A team that is mid-send, or on a paid plan that has not been
        cancelled, is refused rather than half-deleted.
      </p>
      <div>
        <Button
          variant="danger"
          icon={<IconTrash />}
          loading={pending}
          onClick={() => void remove()}
        >
          Delete this team
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
