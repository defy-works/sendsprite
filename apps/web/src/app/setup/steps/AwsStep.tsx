"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Divider } from "@/components/ui/Divider";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import type { WizardProps } from "../types";
import {
  connectKeys,
  detectRole,
  disconnectAws,
  startQuickCreate,
  type Result,
} from "../actions";
import { Alert, Heading, Notice, Panel } from "./shared";

type Connected = { accountId: string; status: string; warning?: string };
type StatusBody = {
  connected: boolean;
  pendingToken: boolean;
  lastFailure?: { at: string; reason: string } | null;
};

const POLL_MS = 3000;

export function AwsStep({
  settings,
  regions,
  defaultRegion,
  oneClickAvailable,
}: WizardProps) {
  if (settings.awsMode !== "none")
    return <ConnectedPanel settings={settings} />;
  return (
    <ConnectPanels
      regions={regions}
      defaultRegion={defaultRegion}
      oneClickAvailable={oneClickAvailable}
    />
  );
}

function ConnectedPanel({ settings }: Pick<WizardProps, "settings">) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <Heading>AWS is connected</Heading>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-white/50">Account</dt>
        <dd>
          <code className="rounded bg-white/8 px-1.5 py-0.5 text-xs">
            {settings.awsAccountId ?? "unknown"}
          </code>
        </dd>
        <dt className="text-white/50">Region</dt>
        <dd>{settings.awsRegion}</dd>
        <dt className="text-white/50">Mode</dt>
        <dd>
          <Badge variant={settings.awsMode === "keys" ? "indigo" : "success"}>
            {settings.awsMode === "keys" ? "access keys" : "instance role"}
          </Badge>
        </dd>
      </dl>
      <div className="flex items-center gap-3">
        <Button asChild>
          <Link href="/setup?step=production">Continue</Link>
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            if (!window.confirm("Disconnect AWS? Sending will stop.")) return;
            start(async () => {
              setError(null);
              const res = await disconnectAws();
              if (!res.ok) setError(res.error);
              else router.refresh();
            });
          }}
        >
          Disconnect
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

function ConnectPanels({
  regions,
  defaultRegion,
  oneClickAvailable,
}: Omit<WizardProps, "settings" | "step">) {
  const router = useRouter();
  const [region, setRegion] = useState(defaultRegion);
  const [manual, setManual] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  // Any successful connect re-renders the page from the server.
  const onConnected = (res: Result<Connected>) => {
    if (res.ok) {
      setWarning(res.data.warning ?? null);
      router.refresh();
    }
    return res;
  };

  const [roleState, roleAction, rolePending] = useActionState(
    async (_prev: unknown, fd: FormData) => onConnected(await detectRole(fd)),
    null,
  );
  const [keysState, keysAction, keysPending] = useActionState(
    async (_prev: unknown, fd: FormData) => onConnected(await connectKeys(fd)),
    null,
  );

  return (
    <div className="flex flex-col gap-5">
      <Heading>Connect AWS</Heading>
      <p className="text-sm text-white/65">
        Sendsprite sends through Amazon SES in your own account. Pick the SES
        region first, then connect one of three ways.
      </p>
      {warning && <Notice>{warning}</Notice>}
      <div>
        <Label htmlFor="region">SES region</Label>
        <Select
          id="region"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
        >
          {regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </div>

      <Panel title="One-click (recommended)">
        <p className="text-sm text-white/65">
          Opens the AWS console with a prepared CloudFormation stack that
          creates a least-privilege IAM user and hands its keys back here.
        </p>
        <QuickCreate
          region={region}
          available={oneClickAvailable}
          onConnected={() => router.refresh()}
        />
      </Panel>

      <Panel title="Use this server's role">
        <p className="text-sm text-white/65">
          If Sendsprite runs on EC2/ECS with an IAM role attached, no keys are
          needed.
        </p>
        <form action={roleAction} className="flex flex-col gap-3">
          <input type="hidden" name="region" value={region} />
          <div>
            <Button type="submit" variant="secondary" disabled={rolePending}>
              {rolePending ? "Checking…" : "Use this server's AWS role"}
            </Button>
          </div>
          {roleState && !roleState.ok && <Alert>{roleState.error}</Alert>}
        </form>
      </Panel>

      <Divider label="or" />
      {!manual ? (
        <div>
          <Button variant="ghost" onClick={() => setManual(true)}>
            Paste keys manually
          </Button>
        </div>
      ) : (
        <Panel title="Manual keys">
          <form action={keysAction} className="flex flex-col gap-3">
            <input type="hidden" name="region" value={region} />
            <div>
              <Label htmlFor="accessKeyId">Access key ID</Label>
              <Input
                id="accessKeyId"
                name="accessKeyId"
                autoComplete="off"
                required
                minLength={16}
              />
            </div>
            <div>
              <Label htmlFor="secretAccessKey">Secret access key</Label>
              <Input
                id="secretAccessKey"
                name="secretAccessKey"
                type="password"
                autoComplete="off"
                required
                minLength={16}
              />
            </div>
            <div>
              <Button type="submit" disabled={keysPending}>
                {keysPending ? "Connecting…" : "Connect"}
              </Button>
            </div>
            {keysState && !keysState.ok && <Alert>{keysState.error}</Alert>}
          </form>
        </Panel>
      )}
    </div>
  );
}

/**
 * One-click flow. The popup is opened synchronously on click (before the
 * server action resolves) so popup blockers let it through; the URL is
 * assigned once the token is issued. If the popup was still blocked, the
 * link is rendered instead. Status is polled until the callback lands.
 */
function QuickCreate({
  region,
  available,
  onConnected,
}: {
  region: string;
  available: boolean;
  onConnected: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Resume polling if the owner comes back with a callback still outstanding.
  useEffect(() => {
    let cancelled = false;
    fetchStatus()
      .then((s) => {
        if (cancelled || !s) return;
        if (s.pendingToken) setPolling(true);
        else if (s.lastFailure) setFailure(s.lastFailure.reason);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    const tick = async () => {
      const s = await fetchStatus();
      if (stopped || !s) return;
      if (s.connected) {
        setPolling(false);
        onConnected();
      } else if (!s.pendingToken) {
        setPolling(false);
        setFailure(
          s.lastFailure?.reason ??
            "The callback did not arrive in time. Try again.",
        );
      }
    };
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [polling, onConnected]);

  const open = () => {
    setError(null);
    setFailure(null);
    setFallbackUrl(null);
    const w = window.open("", "_blank");
    const fd = new FormData();
    fd.set("region", region);
    start(async () => {
      const res = await startQuickCreate(fd);
      if (!res.ok) {
        w?.close();
        setError(res.error);
        return;
      }
      if (w) w.location.href = res.data.url;
      else setFallbackUrl(res.data.url);
      setPolling(true);
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {!available && (
        <Notice>
          One-click connect needs a public https APP_URL; use manual keys
          locally.
        </Notice>
      )}
      <div className="flex items-center gap-3">
        <Button onClick={open} disabled={!available || pending || polling}>
          {pending ? "Preparing…" : "Open AWS console"}
        </Button>
        {polling && (
          <span className="flex items-center gap-2 text-sm text-white/65">
            <Spinner size={14} /> Waiting for CloudFormation…
          </span>
        )}
      </div>
      {polling && (
        <p className="text-sm text-white/65">
          Click <strong>Create stack</strong> in the tab we opened and
          acknowledge the IAM capability checkbox. This page updates on its own.
        </p>
      )}
      {fallbackUrl && (
        <p className="text-sm text-white/65">
          Your browser blocked the popup.{" "}
          <a
            className="text-indigo-300 underline"
            href={fallbackUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the AWS console
          </a>
          .
        </p>
      )}
      {error && <Alert>{error}</Alert>}
      {failure && <Alert>{failure}</Alert>}
    </div>
  );
}

async function fetchStatus(): Promise<StatusBody | null> {
  const r = await fetch("/api/setup/aws/status", { cache: "no-store" });
  return r.ok ? ((await r.json()) as StatusBody) : null;
}
