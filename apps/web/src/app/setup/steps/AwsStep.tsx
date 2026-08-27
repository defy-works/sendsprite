"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Divider } from "@/components/ui/Divider";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Select } from "@/components/ui/Select";
import { useConfirm } from "@/components/ui/confirm";
import type { WizardProps } from "../types";
import {
  connectKeys,
  disconnectAws,
  type DisconnectOutcome,
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
  // Lives here, not in ConnectedPanel: a successful disconnect re-renders
  // the page without that panel, and the outcome has to outlive it.
  const [outcome, setOutcome] = useState<DisconnectOutcome | null>(null);
  return (
    <div className="flex flex-col gap-4">
      {outcome && <DisconnectNotice outcome={outcome} />}
      {settings.awsConnected ? (
        <ConnectedPanel
          settings={settings}
          mode={mode}
          onDisconnected={setOutcome}
        />
      ) : (
        <ConnectPanels
          regions={regions}
          defaultRegion={defaultRegion}
          oneClickAvailable={oneClickAvailable}
        />
      )}
    </div>
  );
}

/**
 * What disconnect did about the stack. `stack_orphaned` is an obligation the
 * owner has to act on — an IAM user with a live access key is still in their
 * account — so it is a standing notice with the link, not a toast.
 */
function DisconnectNotice({ outcome }: { outcome: DisconnectOutcome }) {
  const console = outcome.consoleUrl && (
    <a
      className="underline underline-offset-2"
      href={outcome.consoleUrl}
      target="_blank"
      rel="noopener noreferrer"
    >
      {outcome.stackName ?? "the stack"} in the CloudFormation console
    </a>
  );
  if (outcome.kind === "stack_deleting")
    return (
      <Notice>
        Disconnected. Stack <code>{outcome.stackName}</code> is being deleted
        from your AWS account — the IAM user and its access key go with it,
        which takes about a minute. Your verified domains, configuration set and
        events topic are kept, so reconnecting is quick. Watch it finish:{" "}
        {console}.
      </Notice>
    );
  const why =
    outcome.reason === "no_stack"
      ? "This connection was made with pasted keys, or from a stack older than the current template, so there is no stack for Sendsprite to delete."
      : outcome.reason === "access_denied"
        ? "The stack was created before the template could delete itself, so Sendsprite is not allowed to remove it."
        : `Sendsprite could not delete the stack${outcome.detail ? `: ${outcome.detail}` : "."}`;
  return (
    <Alert>
      Disconnected here, but the IAM user and its access key are still in your
      AWS account. {why}{" "}
      {console ? (
        <>Delete {console} to revoke them.</>
      ) : (
        <>
          Delete the <code>sendsprite-connect-…</code> CloudFormation stack, or
          the IAM user it created, to revoke them.
        </>
      )}
    </Alert>
  );
}

function ConnectedPanel({
  settings,
  mode,
  onDisconnected,
}: Pick<WizardProps, "settings"> & {
  mode: "wizard" | "settings";
  onDisconnected: (outcome: DisconnectOutcome) => void;
}) {
  const router = useRouter();
  const confirm = useConfirm();
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
      </dl>
      {settings.awsLastError && (
        <Alert>
          AWS is refusing this team&apos;s credentials:{" "}
          <code className="text-xs">{settings.awsLastError}</code>. Sending is
          failing. If the connect stack was deleted in the AWS console, the
          access key no longer exists — disconnect below and connect again.
        </Alert>
      )}
      {settings.snsSubscriptionMissing && (
        <Notice>
          SES events are not being delivered: this connection has an SNS topic
          but no confirmed subscription. Reconnect to resume event delivery.
        </Notice>
      )}
      <div className="flex items-center gap-3">
        {mode === "wizard" && (
          <Button asChild>
            <Link href="/setup?step=production">Continue</Link>
          </Button>
        )}
        <Button
          variant="dangerSubtle"
          disabled={pending}
          onClick={async () => {
            // Say what happens to the stack *before* it happens. The two
            // cases read very differently: one is a clean revoke, the other
            // leaves a credential behind that only the owner can remove.
            const ok = await confirm({
              title: "Disconnect AWS?",
              body: settings.awsStackName
                ? `Sending stops for this team the moment the connection goes. The CloudFormation stack ${settings.awsStackName} is deleted from your AWS account, and with it the IAM user and its access key. Verified domains, campaigns and logs are kept.`
                : "Sending stops for this team the moment the connection goes. This connection has no stack Sendsprite can delete, so the IAM user and its access key stay in your AWS account until you remove them. Verified domains, campaigns and logs are kept.",
              confirmLabel: "Disconnect",
              tone: "danger",
            });
            if (!ok) return;
            start(async () => {
              setError(null);
              const res = await disconnectAws();
              if (!res.ok) setError(res.error);
              else {
                onDisconnected(res.data);
                router.refresh();
              }
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

  const [keysState, keysAction, keysPending] = useActionState(
    async (_prev: unknown, fd: FormData) => onConnected(await connectKeys(fd)),
    null,
  );

  return (
    <div className="flex flex-col gap-5">
      <Heading>Connect AWS</Heading>
      <p className="text-sm text-white/65">
        This team sends through Amazon SES in its own AWS account. Pick the SES
        region first, then connect one of two ways.
      </p>
      {warning && <Notice>{warning}</Notice>}
      <div>
        <Label htmlFor="region">SES region</Label>
        <Select
          id="region"
          value={region}
          onChange={setRegion}
          options={regions.map((r) => ({ value: r, label: r }))}
        />
      </div>

      <Panel title="One-click (recommended)">
        <p className="text-sm text-white/65">
          Opens the AWS console with a prepared CloudFormation stack that
          creates a least-privilege IAM user and hands its keys back here.
        </p>
        <QuickCreate region={region} available={oneClickAvailable} />
      </Panel>

      <Divider label="or" />
      {!manual ? (
        <div>
          <Button variant="subtle" onClick={() => setManual(true)}>
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
