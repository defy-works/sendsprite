"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/Button";

export function AcceptInvite(p: {
  invitationId: string;
  teamName: string;
  invitedEmail: string;
  currentEmail: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch =
    p.invitedEmail.toLowerCase() !== p.currentEmail.toLowerCase();
  async function accept() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.organization.acceptInvitation({
        invitationId: p.invitationId,
      });
      if (res.error) {
        setError(res.error.message ?? "Could not accept");
        return;
      }
      await authClient.organization.setActive({
        organizationId: res.data.invitation.organizationId,
      });
      router.push("/app");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 flex flex-col gap-4">
      <p className="text-sm text-white/80">
        You&apos;ve been invited to join <strong>{p.teamName}</strong>.
      </p>
      {mismatch && (
        <p className="text-sm text-amber-300">
          This invitation is for a different account than the one you&apos;re
          signed in as ({p.currentEmail}).
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
      <Button onClick={accept} disabled={mismatch || busy}>
        {busy ? "…" : "Accept invitation"}
      </Button>
    </div>
  );
}
