import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  GetAccountCommand,
  PutAccountDetailsCommand,
  UpdateConfigurationSetEventDestinationCommand,
  type EventDestinationDefinition,
} from "@aws-sdk/client-sesv2";
import {
  CreateTopicCommand,
  SubscribeCommand,
  UnsubscribeCommand,
} from "@aws-sdk/client-sns";
import { z } from "zod";
// Not `@/env`: that module is `server-only` and throws under vitest.
import { loadEnv } from "@/env.schema";
import { makeSes, makeSns, makeSts } from "@/lib/aws/clients";
import type { AwsContext } from "@/lib/aws/credentials";
import { resolveAwsContext } from "@/lib/aws/credentials";
import { SES_REGIONS } from "@/lib/aws/regions";
import { mapAccount, type SesAccount } from "@/lib/aws/ses-account";
import type { Result } from "@/lib/result";
import { configSetName, topicName } from "@/lib/aws/naming";
import {
  disconnectTeamAws,
  getTeamAws,
  updateTeamAws,
  type AwsActor,
  type TeamAws,
} from "./team-aws";

/**
 * Scoped inside the configuration set, which is per team, so this one stays
 * a constant. The config set and topic names are derived from the org slug
 * — see `lib/aws/naming.ts` for why they cannot be.
 */
const EVENT_DESTINATION = "sendsprite-sns";
export const EVENT_TYPES = [
  "SEND",
  "REJECT",
  "BOUNCE",
  "COMPLAINT",
  "DELIVERY",
  "OPEN",
  "CLICK",
  "RENDERING_FAILURE",
  "DELIVERY_DELAY",
  "SUBSCRIPTION",
] as const;

export type Actor = AwsActor;

type Connected = {
  accountId: string;
  status: string;
  /** Set when the connection was persisted but the SES event subscription failed. */
  warning?: string;
};

const errName = (e: unknown) => (e as { name?: string })?.name;
const isAlreadyExists = (e: unknown) => errName(e) === "AlreadyExistsException";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Test hook: replace the propagation-retry sleep. */
export function setSleepForTests(fn: typeof sleep) {
  sleep = fn;
}

/** Errors a freshly created IAM key produces until it has propagated. */
const PROPAGATION_ERRORS = new Set([
  "InvalidClientTokenId",
  "InvalidSignatureException",
  "AuthFailure",
]);
// 5 attempts × 3 s = 12 s of sleeping, ≤ 15 s in total with the calls
// themselves. Keep it there: the CloudFormation Lambda's POST timeout is 45 s
// (infra/aws/sendsprite-connect.yaml) and it does not retry (single-use
// token), so the rest of the connect (config set, topic, subscribe) must fit
// in the remaining budget.
const PROPAGATION_ATTEMPTS = 5;
const PROPAGATION_DELAY_MS = 3_000;

/**
 * STS + GetAccount. A key created seconds ago (the CloudFormation Lambda)
 * can be rejected until IAM propagates it, so both calls are retried on
 * propagation errors within the budget above.
 */
async function verifyIdentity(ctx: AwsContext) {
  for (let attempt = 1; ; attempt++) {
    try {
      const id = await makeSts(ctx).send(new GetCallerIdentityCommand({}));
      if (!id.Account) throw new Error("STS returned no account id");
      const account = await makeSes(ctx).send(new GetAccountCommand({}));
      return { accountId: id.Account, account: mapAccount(account) };
    } catch (e) {
      const name = errName(e);
      if (
        !name ||
        !PROPAGATION_ERRORS.has(name) ||
        attempt >= PROPAGATION_ATTEMPTS
      )
        throw e;
      await sleep(PROPAGATION_DELAY_MS);
    }
  }
}

/**
 * Config set + SNS topic + event destination. Convergent: an existing config
 * set is fine, CreateTopic is idempotent by name, and an existing event
 * destination is updated to the current definition.
 */
export async function ensureSesInfrastructure(
  ctx: AwsContext,
  configSet: string,
  topic: string,
): Promise<{ topicArn: string }> {
  const ses = makeSes(ctx);
  const sns = makeSns(ctx);
  try {
    await ses.send(
      new CreateConfigurationSetCommand({ ConfigurationSetName: configSet }),
    );
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  }
  const created = await sns.send(new CreateTopicCommand({ Name: topic }));
  if (!created.TopicArn) throw new Error("SNS returned no topic ARN");
  const topicArn = created.TopicArn;
  const destination = {
    ConfigurationSetName: configSet,
    EventDestinationName: EVENT_DESTINATION,
    EventDestination: {
      Enabled: true,
      MatchingEventTypes: [...EVENT_TYPES],
      SnsDestination: { TopicArn: topicArn },
    } satisfies EventDestinationDefinition,
  };
  try {
    await ses.send(
      new CreateConfigurationSetEventDestinationCommand(destination),
    );
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
    await ses.send(
      new UpdateConfigurationSetEventDestinationCommand(destination),
    );
  }
  return { topicArn };
}

/**
 * Subscribe the SES webhook to the topic. SNS only accepts https endpoints,
 * so with a non-https APP_URL (local dev) nothing is subscribed and null is
 * returned. Confirmation happens when SNS POSTs to the endpoint (Task 9).
 */
export async function subscribeEndpoint(
  ctx: AwsContext,
  topicArn: string,
  teamId: string,
): Promise<string | null> {
  const endpoint = `${loadEnv().APP_URL}/api/webhooks/ses/${teamId}`;
  if (!endpoint.startsWith("https://")) {
    console.warn(
      `aws-connect: APP_URL is not https; skipping SNS subscription to ${endpoint}. SES events will not be delivered.`,
    );
    return null;
  }
  const sub = await makeSns(ctx).send(
    new SubscribeCommand({
      TopicArn: topicArn,
      Protocol: "https",
      Endpoint: endpoint,
      ReturnSubscriptionArn: true,
    }),
  );
  return sub.SubscriptionArn ?? null;
}

const accountPatch = (a: SesAccount) => ({
  sesAccountStatus: a.status,
  sesReviewStatus: a.reviewStatus,
  sesDailyQuota: a.dailyQuota,
  sesMaxSendRate: a.maxSendRate,
});

/**
 * Verify → provision → persist → subscribe. The topic ARN is stored before
 * SubscribeCommand runs so the confirmation POST (which can arrive before
 * Subscribe returns) finds it; the subscription ARN is a bookkeeping write.
 *
 * `slug` names the AWS resources. It is read once here and persisted on the
 * row — never re-derived, because the org slug is mutable.
 */
async function finishConnect(
  teamId: string,
  slug: string,
  ctx: AwsContext,
  keys: { accessKeyId: string; secretAccessKey: string },
  actor: Actor,
): Promise<Result<Connected>> {
  const { accountId, account } = await verifyIdentity(ctx);
  const configSet = configSetName(slug);
  const { topicArn } = await ensureSesInfrastructure(
    ctx,
    configSet,
    topicName(slug),
  );
  const now = new Date();
  await updateTeamAws(
    teamId,
    {
      region: ctx.region,
      accountId,
      connectedAt: now,
      accessKey: keys.accessKeyId,
      secret: keys.secretAccessKey,
      configSet,
      snsTopicArn: topicArn,
      snsSubscriptionArn: null,
      ...accountPatch(account),
      sesLastCheckedAt: now,
    },
    actor,
    { action: "aws.connect" },
  );
  // Past this point the connection is persisted and consistent. A subscribe
  // failure is reported as a warning rather than an error so a caller (the
  // CloudFormation callback) does not roll back a working connection.
  let warning: string | undefined;
  try {
    const snsSubscriptionArn = await subscribeEndpoint(ctx, topicArn, teamId);
    await updateTeamAws(teamId, { snsSubscriptionArn }, undefined, {
      audit: false,
    });
  } catch (e) {
    console.warn("aws-connect: SNS subscribe failed:", errMsg(e));
    warning = `Connected, but the SES event subscription could not be created: ${errMsg(e)}. Reconnect or fix SNS permissions; sending still works.`;
  }
  return {
    ok: true,
    data: { accountId, status: account.status, ...(warning && { warning }) },
  };
}

/** Connecting over a live connection would silently replace it. */
const ALREADY_CONNECTED: Result<never> = {
  ok: false,
  code: "ALREADY_CONNECTED",
  error: "AWS is already connected. Disconnect first to replace it.",
};

const keysSchema = z.object({
  accessKeyId: z.string().min(16).max(128),
  secretAccessKey: z.string().min(16).max(128),
  region: z.enum(SES_REGIONS),
});

export async function connectWithKeys(
  teamId: string,
  slug: string,
  input: unknown,
  actor: Actor,
): Promise<Result<Connected>> {
  const parsed = keysSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      error: "Access key, secret and a supported SES region are required.",
    };
  const { accessKeyId, secretAccessKey, region } = parsed.data;
  if (await getTeamAws(teamId)) return ALREADY_CONNECTED;
  try {
    return await finishConnect(
      teamId,
      slug,
      { region, credentials: { accessKeyId, secretAccessKey } },
      { accessKeyId, secretAccessKey },
      actor,
    );
  } catch (e) {
    return {
      ok: false,
      error: `AWS rejected the connection: ${errMsg(e)}`,
      code: errName(e),
    };
  }
}

const accountUnchanged = (s: TeamAws, a: SesAccount) =>
  s.sesAccountStatus === a.status &&
  s.sesReviewStatus === a.reviewStatus &&
  s.sesDailyQuota === a.dailyQuota &&
  s.sesMaxSendRate === a.maxSendRate;

/**
 * Re-read GetAccount. Only a real change is audited (`ses.account.refresh`);
 * otherwise (the hourly job, most of the time) just `sesLastCheckedAt` is
 * bumped, unaudited. With `action` set (the production-access request) a
 * row is written even when nothing changed, so the request itself is on
 * record.
 */
export async function refreshSesAccount(
  teamId: string,
  actor?: Actor,
  { action }: { action?: string } = {},
): Promise<Result<{ status: string }>> {
  try {
    const ctx = await resolveAwsContext(teamId);
    const account = mapAccount(
      await makeSes(ctx).send(new GetAccountCommand({})),
    );
    const current = await getTeamAws(teamId);
    const now = new Date();
    if (!action && current && accountUnchanged(current, account)) {
      await updateTeamAws(teamId, { sesLastCheckedAt: now }, undefined, {
        audit: false,
      });
    } else {
      await updateTeamAws(
        teamId,
        { ...accountPatch(account), sesLastCheckedAt: now },
        actor,
        { action: action ?? "ses.account.refresh" },
      );
    }
    return { ok: true, data: { status: account.status } };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

const prodSchema = z.object({
  websiteUrl: z.url(),
  mailType: z.enum(["TRANSACTIONAL", "MARKETING"]),
  useCase: z.string().min(20).max(5000),
  contactEmail: z.email().optional(),
});

export async function requestProductionAccess(
  teamId: string,
  input: unknown,
  actor: Actor,
): Promise<Result<{ status: string }>> {
  const p = prodSchema.safeParse(input);
  if (!p.success)
    return {
      ok: false,
      error:
        "Website URL, mail type and a use-case description (20+ chars) are required.",
    };
  try {
    const ctx = await resolveAwsContext(teamId);
    await makeSes(ctx).send(
      new PutAccountDetailsCommand({
        MailType: p.data.mailType,
        WebsiteURL: p.data.websiteUrl,
        UseCaseDescription: p.data.useCase,
        ContactLanguage: "EN",
        ProductionAccessEnabled: true,
        ...(p.data.contactEmail && {
          AdditionalContactEmailAddresses: [p.data.contactEmail],
        }),
      }),
    );
  } catch (e) {
    return { ok: false, error: `SES rejected the request: ${errMsg(e)}` };
  }
  const refreshed = await refreshSesAccount(teamId, actor, {
    action: "ses.production.request",
  });
  if (!refreshed.ok)
    return {
      ok: false,
      error: `Request submitted, but the status could not be read yet: ${refreshed.error}`,
    };
  return refreshed;
}

/**
 * Forget credentials and SES state. The config set, topic and event
 * destination were created through the API (not by the CloudFormation
 * stack), so they stay in the team's own AWS account; the endpoint
 * subscription is removed best-effort so SNS stops posting to this instance.
 */
export async function disconnectAws(
  teamId: string,
  actor: Actor,
): Promise<Result> {
  const row = await getTeamAws(teamId);
  if (!row) return { ok: false, error: "AWS is not connected." };
  if (row.snsSubscriptionArn) {
    try {
      const ctx = await resolveAwsContext(teamId);
      await makeSns(ctx).send(
        new UnsubscribeCommand({ SubscriptionArn: row.snsSubscriptionArn }),
      );
    } catch (e) {
      console.warn("aws-connect: unsubscribe failed, continuing:", errMsg(e));
    }
  }
  // The row *is* the connection, so disconnecting deletes it rather than
  // nulling a dozen columns and leaving a half-row behind.
  await disconnectTeamAws(teamId, actor);
  return { ok: true, data: undefined };
}
