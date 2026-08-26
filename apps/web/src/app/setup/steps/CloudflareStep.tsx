"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import type { WizardProps } from "../types";
import { disconnectCloudflareAction } from "../actions";
import { Alert, Heading, Notice, Panel } from "./shared";

const CLIENTS_URL = "https://dash.cloudflare.com/?to=/:account/oauth-clients";

/** Cloudflare's `?error=` slugs plus our own, rendered as sentences. */
const ERRORS: Record<string, string> = {
  access_denied: "You cancelled the Cloudflare authorisation.",
  not_configured: "This instance has no Cloudflare OAuth client configured.",
  expired: "That authorisation took too long. Try again.",
  bad_state: "The authorisation could not be verified. Try again.",
  invalid_response: "Cloudflare sent back an unexpected response. Try again.",
  connect_failed: "Cloudflare authorisation failed. Try again.",
};

export function CloudflareStep({
  settings,
  oauthAvailable,
  mode = "wizard",
}: WizardProps) {
  const router = useRouter();
  const params = useSearchParams();
  const connected = Boolean(settings.cloudflareConnectedAt);
  const [disconnecting, start] = useTransition();
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const error = params.get("error");
  const noZones = params.get("cloudflare") === "no_zones";
  const from =
    mode === "wizard" ? "/setup?step=cloudflare" : "/app/settings/instance";
  const startUrl = `/api/setup/cloudflare/start?from=${encodeURIComponent(from)}`;

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
              variant="ghost"
              disabled={disconnecting}
              onClick={() =>
                start(async () => {
                  setDisconnectError(null);
                  const res = await disconnectCloudflareAction();
                  if (!res.ok) setDisconnectError(res.error);
                  else router.refresh();
                })
              }
            >
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
          {disconnectError && <Alert>{disconnectError}</Alert>}
        </div>
      ) : oauthAvailable ? (
        <div className="flex items-center gap-3">
          {/* A plain link, not a form: the flow is a top-level redirect to Cloudflare. */}
          <Button asChild>
            <a href={startUrl}>Connect Cloudflare</a>
          </Button>
          {mode === "wizard" && (
            <Button
              variant="ghost"
              onClick={() => router.push("/setup?step=done")}
            >
              Skip
            </Button>
          )}
        </div>
      ) : (
        <>
          <Panel title="Not configured on this instance">
            <p className="text-sm text-white/75">
              Automatic DNS needs a Cloudflare OAuth client, which this instance
              does not have. Sending domains still work: you add the records at
              your provider, and every domain page shows them with a one-click
              link to the right Cloudflare zone when it detects one.
            </p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-white/75">
              <li>
                In Cloudflare, open{" "}
                <a
                  className="text-indigo-300 underline"
                  href={CLIENTS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Manage Account → OAuth clients
                </a>{" "}
                and create a client.
              </li>
              <li>
                Redirect URI:{" "}
                <code>&lt;APP_URL&gt;/api/setup/cloudflare/callback</code> —
                Cloudflare matches it exactly.
              </li>
              <li>
                Scopes: zone read and DNS write, plus{" "}
                <code>offline_access</code>.
              </li>
              <li>
                Set <code>CLOUDFLARE_OAUTH_CLIENT_ID</code> and{" "}
                <code>CLOUDFLARE_OAUTH_CLIENT_SECRET</code>, then restart.
              </li>
            </ol>
          </Panel>
          {mode === "wizard" && (
            <div>
              <Button asChild>
                <Link href="/setup?step=done">Continue</Link>
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
