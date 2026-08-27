"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Spinner } from "@/components/ui/Spinner";

/** Before SES has issued the tokens the page is mostly empty; poll faster. */
const PROVISIONING_MS = 5_000;
/** Once the records exist, only the verification status is still moving. */
const PENDING_MS = 15_000;

/**
 * Re-renders the domain page from the server while something is still in
 * flight: provisioning (no DKIM tokens yet) or verification (pending). The
 * change stream carries email and webhook events, not domain status, so a
 * timer is what there is. Lives on the page rather than in the actions card
 * so a member who cannot manage domains still sees the records arrive.
 */
export function DomainPoller({
  provisioned,
  status,
}: {
  provisioned: boolean;
  status: "pending" | "verified" | "failed";
}) {
  const router = useRouter();
  useEffect(() => {
    if (provisioned && status !== "pending") return;
    const ms = provisioned ? PENDING_MS : PROVISIONING_MS;
    const t = setInterval(() => {
      // A background tab does not need to re-render.
      if (document.visibilityState === "visible") router.refresh();
    }, ms);
    return () => clearInterval(t);
  }, [provisioned, status, router]);
  if (provisioned) return null;
  return (
    <p className="flex items-center gap-2 text-sm text-white/65">
      <Spinner size={14} />
      Waiting for SES to issue the DNS records — usually under a minute. This
      page updates on its own.
    </p>
  );
}
