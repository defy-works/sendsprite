"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Divider } from "@/components/ui/Divider";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Select } from "@/components/ui/Select";
import type { WizardProps } from "../types";
import {
  connectKeys,
  detectRole,
  disconnectAws,
  type Result,
} from "../actions";
import { QuickCreate } from "./QuickCreate";
import { Alert, Heading, Notice, Panel } from "./shared";

type Connected = { accountId: string; status: string; warning?: string };
export function AwsStep({
  settings,
  regions,
  defaultRegion,
  oneClickAvailable,
  mode = "wizard",
}: WizardProps) {
  if (settings.awsMode !== "none")
    return <ConnectedPanel settings={settings} mode={mode} />;
  return (
    <ConnectPanels
      regions={regions}
      defaultRegion={defaultRegion}
      oneClickAvailable={oneClickAvailable}
    />
  );
}

function ConnectedPanel({
  settings,
  mode,
}: Pick<WizardProps, "settings"> & { mode: "wizard" | "settings" }) {
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
        {mode === "wizard" && (
          <Button asChild>
            <Link href="/setup?step=production">Continue</Link>
          </Button>
        )}
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
}: Pick<WizardProps, "regions" | "defaultRegion" | "oneClickAvailable">) {
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
        <QuickCreate region={region} available={oneClickAvailable} />
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
