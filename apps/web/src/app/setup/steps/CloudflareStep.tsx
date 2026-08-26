"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { IconCloud } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm";
import type { WizardProps } from "../types";
import { disconnectCloudflareAction } from "../actions";
import { Alert, Heading, Notice } from "./shared";

/** Cloudflare's `?error=` slugs plus our own, rendered as sentences. */
const ERRORS: Record<string, string> = {
  access_denied: "You cancelled the Cloudflare authorisation.",
  not_configured: "This instance has no Cloudflare OAuth client configured.",
  expired: "That authorisation took too long. Try again.",
  bad_state: "The authorisation could not be verified. Try again.",
  invalid_response: "Cloudflare sent back an unexpected response. Try again.",
  connect_failed: "Cloudflare authorisation failed. Try again.",
};

/**
 * The Cloudflare connection, for a team.
 *
 * Renders **nothing** when the instance has no OAuth client. It used to render
 * a card headed "Not configured on this instance" with four numbered steps
 * about `CLOUDFLARE_OAUTH_CLIENT_ID` and restarting the server — instructions
 * for whoever operates the deployment, shown to every customer of it, most of
 * whom have no shell on that box and nothing to do about it. Those steps now
 * live at `/admin`, behind `requireInstanceAdmin`, where the person who can
 * act on them will see them. A customer of an instance without the client
 * simply never hears that automatic DNS was a possibility; the manual records
 * and the zone deep link are on every domain page regardless.
 */
export function CloudflareStep({
  settings,
  oauthAvailable,
  mode = "wizard",
}: WizardProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const params = useSearchParams();
  const connected = Boolean(settings.cloudflareConnectedAt);
  const [disconnecting, start] = useTransition();
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  if (!oauthAvailable) return null;

  const error = params.get("error");
  const noZones = params.get("cloudflare") === "no_zones";
  const from =
    mode === "wizard" ? "/setup?step=cloudflare" : "/app/settings#sending";
  const startUrl = `/api/setup/cloudflare/start?from=${encodeURIComponent(from)}`;

  const disconnect = async () => {
    const ok = await confirm({
      title: "Disconnect Cloudflare?",
      body: "New domains stop getting their DNS records written for them — you add DKIM, SPF, DMARC and MX by hand from then on. Records already written stay where they are.",
      confirmLabel: "Disconnect",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      setDisconnectError(null);
      const res = await disconnectCloudflareAction();
      if (!res.ok) setDisconnectError(res.error);
      else router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <Heading>Connect Cloudflare</Heading>
      <p className="text-sm text-white/65">
        Optional. Authorise Sendsprite and it writes the DKIM, SPF, DMARC and MX
        records for your sending domains itself. Without it you add them by hand
        — we show the exact records, and link straight to the right zone when a
        domain is already on Cloudflare.
      </p>
      {error && (
        <Alert>
          {ERRORS[error] ?? "Cloudflare authorisation failed. Try again."}
        </Alert>
      )}
      {noZones && (
        <Notice>
          Cloudflare is connected but the grant covers no zones — authorise
          again and tick the zones you send from.
        </Notice>
      )}

      {connected ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-white/75">
            Cloudflare is connected
            {settings.cloudflareAccountName && (
              <>
                {" "}
                to <strong>{settings.cloudflareAccountName}</strong>
              </>
            )}
            . New domains in a zone you authorised get their records written
            automatically.
          </p>
          <div className="flex items-center gap-3">
            {mode === "wizard" && (
              <Button asChild>
                <Link href="/setup?step=done">Continue</Link>
              </Button>
            )}
            <Button
              variant="dangerSubtle"
              loading={disconnecting}
              onClick={() => void disconnect()}
            >
              Disconnect
            </Button>
          </div>
          {disconnectError && <Alert>{disconnectError}</Alert>}
        </div>
      ) : (
        <div className="flex items-center gap-3">
          {/* A plain link, not a form: the flow is a top-level redirect to Cloudflare. */}
          <Button asChild>
            <a href={startUrl}>
              <IconCloud />
              Connect Cloudflare
            </a>
          </Button>
          {mode === "wizard" && (
            <Button
              variant="subtle"
              onClick={() => router.push("/setup?step=done")}
            >
              Skip
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
