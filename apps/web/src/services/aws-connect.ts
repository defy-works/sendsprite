import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  GetAccountCommand,
  PutAccountDetailsCommand,
} from "@aws-sdk/client-sesv2";
import { CreateTopicCommand, SubscribeCommand } from "@aws-sdk/client-sns";
import { z } from "zod";
// Not `@/env`: that module is `server-only` and throws under vitest.
import { loadEnv } from "@/env.schema";
import { makeSes, makeSns, makeSts } from "@/lib/aws/clients";
import type { AwsContext } from "@/lib/aws/credentials";
import { resolveAwsContext } from "@/lib/aws/credentials";
import { mapAccount } from "@/lib/aws/ses-account";
import type { RequestMeta } from "@/lib/audit";
import type { Result } from "@/lib/result";
import {
  getInstanceSettings,
  updateInstanceSettings,
} from "./instance-settings";

export const CONFIG_SET = "sendsprite";
export const TOPIC_NAME = "sendsprite-events";
const EVENT_DESTINATION = "sendsprite-sns";
const EVENT_TYPES = [
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

export interface Actor {
  userId: string;
  meta?: RequestMeta;
}

type Connected = { accountId: string; status: string };

const isAlreadyExists = (e: unknown) =>
  (e as { name?: string })?.name === "AlreadyExistsException";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function verifyIdentity(ctx: AwsContext) {
  const id = await makeSts(ctx).send(new GetCallerIdentityCommand({}));
  if (!id.Account) throw new Error("STS returned no account id");
  const account = await makeSes(ctx).send(new GetAccountCommand({}));
  return { accountId: id.Account, account: mapAccount(account) };
}

/**
 * Creates config set + SNS topic + event destination + HTTPS subscription.
 * Idempotent: "already exists" is success, CreateTopic is idempotent by name.
 * SNS only accepts https endpoints, so on a non-https APP_URL (local dev)
 * the subscription is skipped and `subscriptionArn` is null.
 */
export async function ensureSesInfrastructure(ctx: AwsContext) {
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
  try {
    await ses.send(
      new CreateConfigurationSetEventDestinationCommand({
        ConfigurationSetName: CONFIG_SET,
        EventDestinationName: EVENT_DESTINATION,
        EventDestination: {
          Enabled: true,
          MatchingEventTypes: [...EVENT_TYPES],
          SnsDestination: { TopicArn: topicArn },
        },
      }),
    );
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  }
  const endpoint = `${loadEnv().APP_URL}/api/webhooks/ses`;
  if (!endpoint.startsWith("https://")) {
    console.warn(
      `aws-connect: APP_URL is not https; skipping SNS subscription to ${endpoint}. SES events will not be delivered.`,
    );
    return { topicArn, subscriptionArn: null };
  }
  const sub = await sns.send(
    new SubscribeCommand({
      TopicArn: topicArn,
      Protocol: "https",
      Endpoint: endpoint,
      ReturnSubscriptionArn: true,
    }),
  );
  return { topicArn, subscriptionArn: sub.SubscriptionArn ?? null };
}

async function finishConnect(
  ctx: AwsContext,
  mode: "keys" | "instance_role",
  keys: { accessKeyId: string; secretAccessKey: string } | null,
  actor: Actor,
): Promise<Result<Connected>> {
  const { accountId, account } = await verifyIdentity(ctx);
  const infra = await ensureSesInfrastructure(ctx);
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
      snsTopicArn: infra.topicArn,
      snsSubscriptionArn: infra.subscriptionArn,
      sesAccountStatus: account.status,
      sesReviewStatus: account.reviewStatus,
      sesDailyQuota: account.dailyQuota,
      sesMaxSendRate: account.maxSendRate,
      sesLastCheckedAt: now,
    },
    actor,
  );
  return { ok: true, data: { accountId, status: account.status } };
}

const keysSchema = z.object({
  accessKeyId: z.string().min(16).max(128),
  secretAccessKey: z.string().min(16).max(128),
  region: z.string().min(1),
});

export async function connectWithKeys(
  input: unknown,
  actor: Actor,
): Promise<Result<Connected>> {
  const parsed = keysSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: "Access key, secret and region are required." };
  const { accessKeyId, secretAccessKey, region } = parsed.data;
  try {
    return await finishConnect(
      { region, credentials: { accessKeyId, secretAccessKey } },
      "keys",
      { accessKeyId, secretAccessKey },
      actor,
    );
  } catch (e) {
    return { ok: false, error: `AWS rejected the connection: ${errMsg(e)}` };
  }
}

/** Try the SDK default credential chain (EC2/ECS role, env). Never throws. */
export async function detectInstanceRole(
  region: string,
  actor: Actor,
): Promise<Result<Connected>> {
  try {
    return await finishConnect({ region }, "instance_role", null, actor);
  } catch (e) {
    return {
      ok: false,
      error: `No usable AWS credentials on this host: ${errMsg(e)}`,
    };
  }
}

export async function refreshSesAccount(
  actor?: Actor,
): Promise<Result<{ status: string }>> {
  try {
    const ctx = await resolveAwsContext();
    const account = mapAccount(
      await makeSes(ctx).send(new GetAccountCommand({})),
    );
    await updateInstanceSettings(
      {
        sesAccountStatus: account.status,
        sesReviewStatus: account.reviewStatus,
        sesDailyQuota: account.dailyQuota,
        sesMaxSendRate: account.maxSendRate,
        sesLastCheckedAt: new Date(),
      },
      actor,
    );
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
    return await refreshSesAccount(actor);
  } catch (e) {
    return { ok: false, error: `SES rejected the request: ${errMsg(e)}` };
  }
}

/** Forget credentials; SES resources are left in the account (stack deletion cleans them). */
export async function disconnectAws(actor: Actor): Promise<Result> {
  const s = await getInstanceSettings();
  if (s.awsMode === "none")
    return { ok: false, error: "AWS is not connected." };
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
