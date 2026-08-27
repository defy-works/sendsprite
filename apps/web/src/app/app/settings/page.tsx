import { and, eq, gt } from "drizzle-orm";
import { can } from "@sendsprite/shared";
import { db } from "@/db";
import { invitation, member, user } from "@/db/schema";
import { env } from "@/env";
import { SES_REGIONS } from "@/lib/aws/regions";
import { requireTeam } from "@/lib/session";
import { billingConfig } from "@/services/billing/config";
import { getInstanceSettings } from "@/services/instance-settings";
import { getTeamAws } from "@/services/team-aws";
import { getTeamSettings } from "@/services/team-settings";
import {
  getTeamCloudflare,
  oauthAvailable,
} from "@/services/cloudflare-connect";
import { effectiveRetentionDays } from "@/services/retention-policy";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Link } from "@/components/ui/Link";
import { PageHeader } from "@/components/ui/PageHeader";
import { AwsStep } from "@/app/setup/steps/AwsStep";
import { ProductionStep } from "@/app/setup/steps/ProductionStep";
import { CloudflareStep } from "@/app/setup/steps/CloudflareStep";
import type { WizardProps, WizardSettings } from "@/app/setup/types";
import { RenameForm } from "./RenameForm";
import { MembersPanel } from "./MembersPanel";
import { InvitePanel } from "./InvitePanel";
import { RetentionForm } from "./RetentionForm";
import { DangerZone } from "./DangerZone";

export const metadata = { title: "Settings" };

// Server-side formatting: a locale/timezone-dependent toLocaleDateString in a
// client component would hydrate differently from the SSR markup.
const formatDate = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);

/**
 * One page, not a hub of links.
 *
 * Sending used to live at `/app/settings/sending`, reached by a card whose
 * whole content was a sentence and a link — so connecting AWS meant finding
 * Settings, reading a card that did nothing, and clicking through to the page
 * that did. The steps are components already (the wizard renders the same
 * three), so there was never anything to build: they render here, in `settings`
 * mode, under their own heading.
 */
export default async function SettingsPage() {
  const ctx = await requireTeam();
  const isAdmin = ctx.role === "owner" || ctx.role === "admin";

  const members = await db()
    .select({
      id: member.id,
      userId: member.userId,
      role: member.role,
      email: user.email,
      name: user.name,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, ctx.team.id))
    .orderBy(member.createdAt);
  const invites = (
    await db()
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, ctx.team.id),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, new Date()),
        ),
      )
      .orderBy(invitation.expiresAt)
  ).map(({ expiresAt, ...i }) => ({ ...i, expires: formatDate(expiresAt) }));

  const [instance, settings, aws, cf] = await Promise.all([
    getInstanceSettings(),
    getTeamSettings(ctx.team.id),
    // Only an admin may see the connection details; a member gets no Sending
    // section at all, so the queries are skipped rather than filtered.
    isAdmin ? getTeamAws(ctx.team.id) : Promise.resolve(null),
    isAdmin ? getTeamCloudflare(ctx.team.id) : Promise.resolve(null),
  ]);

  const cfOauth = oauthAvailable();
  const sending: WizardProps = {
    // Only serialisable, non-secret fields cross into the client tree.
    settings: {
      awsConnected: aws !== null,
      awsRegion: aws?.region ?? null,
      awsAccountId: aws?.accountId ?? null,
      sesAccountStatus: aws?.sesAccountStatus ?? null,
      sesReviewStatus: aws?.sesReviewStatus ?? null,
      sesDailyQuota: aws?.sesDailyQuota ?? null,
      sesMaxSendRate: aws?.sesMaxSendRate ?? null,
      snsSubscriptionMissing: Boolean(
        aws?.snsTopicArn && !aws.snsSubscriptionArn,
      ),
      cloudflareConnectedAt: cf?.connectedAt?.toISOString() ?? null,
      cloudflareAccountName: cf?.accountName ?? null,
      setupCompleted: settings?.setupCompleted ?? false,
    } satisfies WizardSettings,
    step: "aws",
    regions: SES_REGIONS,
    defaultRegion: env.AWS_DEFAULT_REGION,
    oneClickAvailable: env.APP_URL.startsWith("https://"),
    oauthAvailable: cfOauth,
    mode: "settings",
  };

  const billingEnabled = billingConfig().enabled;

  /*
   * No in-page rail.
   *
   * This page used to grow a sticky column of its own section links, which put
   * two navigation columns side by side — the app's and the page's — with
   * nothing to say which was in charge. The sections are listed under Settings
   * in the sidebar now (`settingsSections`, shared so the two lists cannot
   * drift), which is where everything else navigable already is.
   */
  return (
    <div className="flex">
      <div className="flex min-w-0 max-w-3xl flex-1 flex-col gap-8">
        <PageHeader
          title="Settings"
          description="Everything about this team: who is on it, where it sends from, and how long its mail log is kept."
        />

        <Section id="team" title="Team">
          <Card>
            <CardBody>
              {/* Keyed on the name so a successful rename resets the field's defaultValue. */}
              <RenameForm
                key={ctx.team.name}
                name={ctx.team.name}
                disabled={!can(ctx.role, "team.rename")}
              />
            </CardBody>
          </Card>
        </Section>

        <Section id="members" title="Members">
          <Card>
            <CardBody>
              <MembersPanel
                members={members}
                me={ctx.userId}
                myRole={ctx.role}
              />
            </CardBody>
          </Card>
          {can(ctx.role, "members.invite") && (
            <Card>
              <CardHeader>
                <CardTitle>Invitations</CardTitle>
              </CardHeader>
              <CardBody>
                <InvitePanel invites={invites} />
              </CardBody>
            </Card>
          )}
        </Section>

        {isAdmin && (
          <Section
            id="sending"
            title="Sending"
            description="This team sends through its own AWS account. Nothing here is shared with any other team on this instance."
          >
            <Card>
              <CardBody>
                <AwsStep {...sending} />
              </CardBody>
            </Card>
            <Card>
              <CardBody>
                <ProductionStep {...sending} />
              </CardBody>
            </Card>
            {/* Rendered only when this instance has an OAuth client: the
                registration steps are an operator's job and live at /admin. */}
            {cfOauth && (
              <Card>
                <CardBody>
                  <CloudflareStep {...sending} />
                </CardBody>
              </Card>
            )}
          </Section>
        )}

        <Section id="retention">
          <Card>
            <CardHeader>
              <CardTitle>Retention</CardTitle>
            </CardHeader>
            <CardBody>
              <RetentionForm
                retentionDays={effectiveRetentionDays(
                  settings?.retentionDays ?? null,
                  instance.retentionDays,
                )}
                instanceMax={instance.retentionDays}
                canManage={can(ctx.role, "settings.manage")}
              />
            </CardBody>
          </Card>
        </Section>

        {billingEnabled && (
          <Section id="billing">
            <Card>
              <CardHeader>
                <CardTitle>Billing</CardTitle>
              </CardHeader>
              <CardBody>
                <p className="text-sm text-white/70">
                  Your plan, this period&apos;s usage and payment details.{" "}
                  <Link href="/app/settings/billing">Open billing</Link>
                </p>
              </CardBody>
            </Card>
          </Section>
        )}

        {ctx.role === "owner" && (
          <Section id="danger" title="Danger zone">
            <div className="rounded-lg border border-danger/35 bg-danger/6 p-5">
              <DangerZone
                teamName={ctx.team.name}
                isOwner
                memberCount={members.length}
              />
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

/** A titled band of cards with an anchor the rail can jump to. */
function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  /** Omitted when the single card inside already carries the title. */
  title?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    // `scroll-mt` matches the scrolling container's own gutter, so an anchor
    // jump leaves the heading the same inset the page has everywhere else.
    <section id={id} className="flex scroll-mt-6 flex-col gap-4">
      {title && (
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">{title}</h2>
          {description && (
            <p className="text-sm text-white/55">{description}</p>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
