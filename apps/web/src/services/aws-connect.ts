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
import {
  getInstanceSettings,
  updateInstanceSettings,
  type InstanceActor,
  type InstanceSettings,
} from "./instance-settings";

export const CONFIG_SET = "sendsprite";
export const TOPIC_NAME = "sendsprite-events";
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

export type Actor = InstanceActor;

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
const PROPAGATION_ATTEMPTS = 6;
const PROPAGATION_DELAY_MS = 3_000;

/**
 * STS + GetAccount. A key created seconds ago (the CloudFormation Lambda)
 * can be rejected until IAM propagates it, so both calls are retried up to
 * ~18 s on propagation errors; the Lambda's POST timeout is 25 s.
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
): Promise<{ topicArn: string }> {
  const ses = makeSes(ctx);
  const sns = makeSns(ctx);
  try {
    await ses.send(
      new CreateConfigurationSetCommand({ ConfigurationSetName: CONFIG_SET }),
    );
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  }
  const topic = await sns.send(new CreateTopicCommand({ Name: TOPIC_NAME }));
  if (!topic.TopicArn) throw new Error("SNS returned no topic ARN");
  const topicArn = topic.TopicArn;
  const destination = {
    ConfigurationSetName: CONFIG_SET,
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
): Promise<string | null> {
  const endpoint = `${loadEnv().APP_URL}/api/webhooks/ses`;
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
 */
async function finishConnect(
  ctx: AwsContext,
  mode: "keys" | "instance_role",
  keys: { accessKeyId: string; secretAccessKey: string } | null,
  actor: Actor,
): Promise<Result<Connected>> {
  const { accountId, account } = await verifyIdentity(ctx);
  const { topicArn } = await ensureSesInfrastructure(ctx);
  const now = new Date();
  await updateInstanceSettings(
    {
      awsMode: mode,
      awsRegion: ctx.region,
      awsAccountId: accountId,
      awsConnectedAt: now,
      awsAccessKey: keys?.accessKeyId ?? null,
      awsSecret: keys?.secretAccessKey ?? null,
      sesConfigSet: CONFIG_SET,
      snsTopicArn: topicArn,
      snsSubscriptionArn: null,
      ...accountPatch(account),
      sesLastCheckedAt: now,
    },
    actor,
  );
  // Past this point the connection is persisted and consistent. A subscribe
  // failure is reported as a warning rather than an error so a caller (the
  // CloudFormation callback) does not roll back a working connection.
  let warning: string | undefined;
  try {
    const snsSubscriptionArn = await subscribeEndpoint(ctx, topicArn);
    await updateInstanceSettings({ snsSubscriptionArn }, undefined, {
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

const keysSchema = z.object({
  accessKeyId: z.string().min(16).max(128),
  secretAccessKey: z.string().min(16).max(128),
  region: z.enum(SES_REGIONS),
});

export async function connectWithKeys(
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
  try {
    return await finishConnect(
      { region, credentials: { accessKeyId, secretAccessKey } },
      "keys",
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

/** Try the SDK default credential chain (EC2/ECS role, env, profile). Never throws. */
export async function detectInstanceRole(
  region: string,
  actor: Actor,
): Promise<Result<Connected>> {
  try {
    return await finishConnect({ region }, "instance_role", null, actor);
  } catch (e) {
    if (errName(e) === "CredentialsProviderError")
      return {
        ok: false,
        error:
          "No AWS credentials found on this host. Run on EC2/ECS with a role attached, or use one-click / manual keys.",
      };
    return {
      ok: false,
      error: `No usable AWS credentials on this host: ${errMsg(e)}`,
    };
  }
}

const accountUnchanged = (s: InstanceSettings, a: SesAccount) =>
  s.sesAccountStatus === a.status &&
  s.sesReviewStatus === a.reviewStatus &&
  s.sesDailyQuota === a.dailyQuota &&
  s.sesMaxSendRate === a.maxSendRate;

/**
 * Re-read GetAccount. Only a real change is audited; otherwise (the hourly
 * job, most of the time) just `sesLastCheckedAt` is bumped, unaudited.
 */
export async function refreshSesAccount(
  actor?: Actor,
): Promise<Result<{ status: string }>> {
  try {
    const ctx = await resolveAwsContext();
    const account = mapAccount(
      await makeSes(ctx).send(new GetAccountCommand({})),
    );
    const current = await getInstanceSettings();
    const now = new Date();
    if (accountUnchanged(current, account)) {
      await updateInstanceSettings({ sesLastCheckedAt: now }, undefined, {
        audit: false,
      });
    } else {
      await updateInstanceSettings(
        { ...accountPatch(account), sesLastCheckedAt: now },
        actor,
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
    const ctx = await resolveAwsContext();
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
  const refreshed = await refreshSesAccount(actor);
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
 * stack), so they stay in the account; the endpoint subscription is removed
 * best-effort so SNS stops posting to this instance.
 */
export async function disconnectAws(actor: Actor): Promise<Result> {
  const s = await getInstanceSettings();
  if (s.awsMode === "none")
    return { ok: false, error: "AWS is not connected." };
  if (s.snsSubscriptionArn) {
    try {
      const ctx = await resolveAwsContext();
      await makeSns(ctx).send(
        new UnsubscribeCommand({ SubscriptionArn: s.snsSubscriptionArn }),
      );
    } catch (e) {
      console.warn("aws-connect: unsubscribe failed, continuing:", errMsg(e));
    }
  }
  await updateInstanceSettings(
    {
      awsMode: "none",
      awsAccessKey: null,
      awsSecret: null,
      awsAccountId: null,
      awsConnectedAt: null,
      snsTopicArn: null,
      snsSubscriptionArn: null,
      sesConfigSet: null,
      sesAccountStatus: null,
      sesReviewStatus: null,
      sesDailyQuota: null,
      sesMaxSendRate: null,
      sesLastCheckedAt: null,
    },
    actor,
  );
  return { ok: true, data: undefined };
}
