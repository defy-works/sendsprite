import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { CopyField } from "@/components/ui/CopyField";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusDot } from "@/components/ui/StatusDot";
import { env } from "@/env";
import { requireInstanceAdmin } from "@/lib/session";
import { instanceStats } from "@/services/admin";
import { oauthAvailable } from "@/services/cloudflare-connect";
import { getInstanceSettings } from "@/services/instance-settings";
import { InstanceForm } from "./InstanceForm";

export const metadata = { title: "Instance" };

const CLIENTS_URL = "https://dash.cloudflare.com/?to=/:account/oauth-clients";

export default async function AdminPage() {
  await requireInstanceAdmin();
  const [s, stats] = await Promise.all([
    getInstanceSettings(),
    instanceStats(),
  ]);
  const cf = oauthAvailable();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Instance"
        description="Settings that belong to whoever runs this deployment, not to any one team."
      />

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Teams" value={stats.teams} />
        <Stat label="Users" value={stats.users} />
        <Stat label="Domains" value={stats.domains} />
        <Stat label="AWS connected" value={stats.awsConnected} />
        <Stat label="Sent · 30d" value={stats.sent30d} />
        <Stat label="Suspended" value={stats.suspended} tone="danger" />
      </dl>

      <Card>
        <CardHeader>
          <CardTitle>Access and retention</CardTitle>
        </CardHeader>
        <CardBody>
          <InstanceForm
            signupMode={s.signupMode ?? "auto"}
            landingEnabled={s.landingEnabled ?? true}
            retentionDays={s.retentionDays}
            envSignupMode={env.SIGNUP_MODE}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cloudflare OAuth client</CardTitle>
          <StatusDot
            status={cf ? "ok" : "off"}
            label={cf ? "Configured" : "Not configured"}
          />
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {/* These instructions used to sit on the customer-facing Cloudflare
              setup step, where they told people without a shell on this box to
              set an environment variable and restart it. This is where the
              person who can do that will look. */}
          {cf ? (
            <p className="text-sm text-white/70">
              Teams on this instance can authorise Cloudflare and have their
              DKIM, SPF, DMARC and MX records written for them. Without it they
              add records by hand — which still works, and is what every team
              here is doing right now if this ever gets unset.
            </p>
          ) : (
            <>
              <p className="text-sm text-white/70">
                Automatic DNS needs a Cloudflare OAuth client. Until one is
                configured, teams add their records by hand and are never shown
                that automatic DNS was an option.
              </p>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-white/70">
                <li>
                  In Cloudflare, open{" "}
                  <a
                    className="text-indigo-300 underline underline-offset-2"
                    href={CLIENTS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Manage Account → OAuth clients
                  </a>{" "}
                  and create a client.
                </li>
                <li>
                  Redirect URI — Cloudflare matches it exactly, no wildcards:
                  <span className="mt-1 block">
                    <CopyField
                      value={`${env.APP_URL}/api/setup/cloudflare/callback`}
                    />
                  </span>
                </li>
                <li>
                  Scopes: zone read and DNS write, plus{" "}
                  <code className="rounded bg-white/8 px-1 py-0.5 text-xs">
                    offline_access
                  </code>
                  .
                </li>
                <li>
                  Set{" "}
                  <code className="rounded bg-white/8 px-1 py-0.5 text-xs">
                    CLOUDFLARE_OAUTH_CLIENT_ID
                  </code>{" "}
                  and{" "}
                  <code className="rounded bg-white/8 px-1 py-0.5 text-xs">
                    CLOUDFLARE_OAUTH_CLIENT_SECRET
                  </code>
                  , then restart this instance.
                </li>
              </ol>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger";
}) {
  return (
    <div className="glass flex flex-col gap-1 p-3.5">
      <dt className="num-stamp">{label}</dt>
      <dd
        className={`tnum text-2xl font-semibold tracking-[-0.02em] ${
          tone === "danger" && value > 0 ? "text-red-300" : ""
        }`}
      >
        {value.toLocaleString("en-US")}
      </dd>
    </div>
  );
}
