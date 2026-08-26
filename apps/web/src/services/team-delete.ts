import { DeleteConfigurationSetCommand } from "@aws-sdk/client-sesv2";
import { DeleteTopicCommand, UnsubscribeCommand } from "@aws-sdk/client-sns";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { campaigns, organization, teamBilling } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { makeSes, makeSns } from "@/lib/aws/clients";
import { resolveAwsContext } from "@/lib/aws/credentials";
import type { Result } from "@/lib/result";
import { listDomains, deleteDomain } from "./domains";
import { disconnectCloudflare } from "./cloudflare-connect";
import { getTeamAws } from "./team-aws";
import type { TeamActor } from "./team";

/**
 * Deleting a team.
 *
 * The row would cascade on its own — every team-scoped table references
 * `organization.id` with `ON DELETE CASCADE`, so one `DELETE` empties the
 * database side completely. That is exactly why this file exists: the database
 * is not where a team's footprint ends. A team owns an SES configuration set,
 * an SNS topic and subscription, a set of SES identities and a pile of DNS
 * records, all of them living in **someone else's** AWS and Cloudflare
 * accounts, and none of them reachable once the credentials that addressed
 * them have cascaded away.
 *
 * So the order is fixed and it is the only order that works: everything that
 * needs the team's own credentials happens first, while they still exist, and
 * the row goes last.
 *
 * ## What this refuses to do
 *
 * **A campaign that is sending.** Its fan-out is a queued job holding a
 * campaign id; cascading the row out from under a live send turns every
 * remaining batch into an error and leaves half a contact book mailed with no
 * record of why it stopped. Cancel it and the delete goes through.
 *
 * **A team with a live paid subscription.** We cannot cancel a Polar
 * subscription from here and pretending otherwise is how somebody keeps being
 * charged for a team that no longer exists. The message says where to go.
 *
 * ## What it reports rather than hides
 *
 * Third-party teardown is best-effort by nature — a revoked AWS key, a
 * Cloudflare grant already withdrawn, a network that picks the wrong moment.
 * None of that can be allowed to block the delete (the alternative is a team
 * nobody can get rid of), so failures are counted and returned. The caller
 * tells the operator exactly what is still out there instead of reporting a
 * clean deletion over the top of an orphaned SNS topic.
 */
export interface DeleteTeamOutcome {
  /** Domains whose SES identity or DNS records could not be cleaned up. */
  domainsWithLeftovers: number;
  /** DNS records left behind across all of those domains. */
  leftoverDnsRecords: number;
  /** The SES configuration set / SNS topic could not be removed. */
  awsLeftovers: boolean;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function deleteTeam(
  actor: TeamActor,
  deps: { fetch: typeof globalThis.fetch },
): Promise<Result<DeleteTeamOutcome>> {
  // Owner only, and not by `can()`: `settings.manage` is held by admins too,
  // and an admin removing the team that granted them the role is not a
  // permission this product wants to hand out.
  if (actor.role !== "owner")
    return {
      ok: false,
      error: "Only the team owner can delete a team.",
    };

  const sending = await db()
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.teamId, actor.teamId),
        inArray(campaigns.status, ["sending"]),
      ),
    )
    .limit(1);
  if (sending[0])
    return {
      ok: false,
      error: `"${sending[0].name}" is still sending. Cancel it first — deleting the team mid-send would strand the rest of its recipients.`,
    };

  const [billing] = await db()
    .select({ plan: teamBilling.plan, status: teamBilling.status })
    .from(teamBilling)
    .where(eq(teamBilling.teamId, actor.teamId))
    .limit(1);
  if (billing && billing.plan !== "free" && billing.status === "active")
    return {
      ok: false,
      error:
        "This team has an active subscription. Cancel it under Billing first, so you are not charged for a team that no longer exists.",
    };

  const outcome: DeleteTeamOutcome = {
    domainsWithLeftovers: 0,
    leftoverDnsRecords: 0,
    awsLeftovers: false,
  };

  // 1. Domains, one at a time and through the real path: it deletes the SES
  //    identity and the DNS records this product wrote, which a cascade
  //    cannot do. A failure is counted, not fatal.
  for (const d of await listDomains(actor.teamId)) {
    const res = await deleteDomain(actor, d.id, deps);
    if (!res.ok) {
      outcome.domainsWithLeftovers++;
      console.warn(`[team-delete] ${d.name}: ${res.error}`);
      continue;
    }
    if (res.data.leftoverDnsRecords > 0) {
      outcome.domainsWithLeftovers++;
      outcome.leftoverDnsRecords += res.data.leftoverDnsRecords;
    }
  }

  // 2. Cloudflare, so the grant is withdrawn on Cloudflare's side rather than
  //    left dangling in the customer's authorised-applications list.
  await disconnectCloudflare(actor.teamId, {
    userId: actor.userId,
    meta: actor.meta,
  }).catch((e: unknown) =>
    console.warn("[team-delete] cloudflare disconnect:", errMsg(e)),
  );

  // 3. The AWS resources this product created in the customer's account.
  //    Deeper than `disconnectAws`, deliberately: disconnecting is reversible
  //    and leaving the topic in place makes reconnecting cheap, while deleting
  //    the team is not reversible and leaving them is just litter in an
  //    account we will never touch again.
  const aws = await getTeamAws(actor.teamId);
  if (aws) {
    try {
      const ctx = await resolveAwsContext(actor.teamId);
      const sns = makeSns(ctx);
      if (aws.snsSubscriptionArn)
        await sns.send(
          new UnsubscribeCommand({ SubscriptionArn: aws.snsSubscriptionArn }),
        );
      await makeSes(ctx).send(
        new DeleteConfigurationSetCommand({
          ConfigurationSetName: aws.configSet,
        }),
      );
      if (aws.snsTopicArn)
        await sns.send(new DeleteTopicCommand({ TopicArn: aws.snsTopicArn }));
    } catch (e) {
      outcome.awsLeftovers = true;
      console.warn("[team-delete] aws teardown:", errMsg(e));
    }
  }

  // 4. The row. Everything team-scoped cascades from here.
  await db().delete(organization).where(eq(organization.id, actor.teamId));

  // 5. `audit_log.team_id` carries no foreign key on purpose, so the record of
  //    the deletion outlives the thing deleted. Written last, because writing
  //    it first and then failing would claim something that did not happen.
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "team.delete",
    targetType: "team",
    targetId: actor.teamId,
    diff: {
      name: { from: actor.teamName },
      leftoverDnsRecords: { to: outcome.leftoverDnsRecords },
      awsLeftovers: { to: outcome.awsLeftovers },
    },
    ...actor.meta,
  });

  return { ok: true, data: outcome };
}
