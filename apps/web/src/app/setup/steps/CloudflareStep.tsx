"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import type { WizardProps } from "../types";
import {
  connectCloudflareAction,
  disconnectCloudflareAction,
} from "../actions";
import { Alert, Heading, Notice, Panel } from "./shared";

const TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

export function CloudflareStep({ settings }: WizardProps) {
  const router = useRouter();
  const connected = Boolean(settings.cloudflareConnectedAt);
  const [zones, setZones] = useState<string[] | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => {
      const res = await connectCloudflareAction(fd);
      if (res.ok) {
        setZones(res.data.zones.map((z) => z.name));
        setWarning(res.data.warning ?? null);
        router.refresh();
      }
      return res;
    },
    null,
  );
  const [disconnecting, start] = useTransition();
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <Heading>Connect Cloudflare</Heading>
      <p className="text-sm text-white/65">
        Optional. With a Cloudflare API token Sendsprite writes the DKIM, SPF,
        DMARC and MX records for your sending domains itself; without it you add
        them by hand.
      </p>
      {warning && <Notice>{warning}</Notice>}

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
            .
          </p>
          {zones && zones.length > 0 && <ZoneList zones={zones} />}
          <div className="flex items-center gap-3">
            <Button asChild>
              <Link href="/setup?step=done">Continue</Link>
            </Button>
            <Button
              variant="ghost"
              disabled={disconnecting}
              onClick={() =>
                start(async () => {
                  setDisconnectError(null);
                  const res = await disconnectCloudflareAction();
                  if (!res.ok) setDisconnectError(res.error);
                  else {
                    setZones(null);
                    router.refresh();
                  }
                })
              }
            >
              Disconnect
            </Button>
          </div>
          {disconnectError && <Alert>{disconnectError}</Alert>}
        </div>
      ) : (
        <>
          <Panel title="Create a token">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-white/75">
              <li>
                Open{" "}
                <a
                  className="text-indigo-300 underline"
                  href={TOKENS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  dash.cloudflare.com/profile/api-tokens
                </a>{" "}
                and choose <strong>Create Token</strong> → Custom token.
              </li>
              <li>
                Permissions: <em>Zone → Zone → Read</em> and{" "}
                <em>Zone → DNS → Edit</em>.
              </li>
              <li>
                Zone resources: the zones you will send from (or all zones).
              </li>
              <li>Create it and paste the token below.</li>
            </ol>
          </Panel>
          <form action={action} className="flex flex-col gap-3">
            <div>
              <Label htmlFor="token">API token</Label>
              <Input
                id="token"
                name="token"
                type="password"
                autoComplete="off"
                required
                minLength={10}
              />
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={pending}>
                {pending ? "Verifying…" : "Connect Cloudflare"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => router.push("/setup?step=done")}
              >
                Skip
              </Button>
            </div>
            <p className="text-xs text-white/50">
              Skip if you would rather add DNS records manually.
            </p>
            {state && !state.ok && <Alert>{state.error}</Alert>}
          </form>
        </>
      )}
    </div>
  );
}

function ZoneList({ zones }: { zones: string[] }) {
  return (
    <div className="text-sm">
      <p className="text-white/50">Zones this token can manage:</p>
      <ul className="mt-1 flex flex-wrap gap-2">
        {zones.map((z) => (
          <li key={z}>
            <code className="rounded bg-white/8 px-1.5 py-0.5 text-xs">
              {z}
            </code>
          </li>
        ))}
      </ul>
    </div>
  );
}
