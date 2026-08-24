import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SESv2Client,
  GetAccountCommand,
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
} from "@aws-sdk/client-sesv2";
import {
  SNSClient,
  CreateTopicCommand,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { user } from "@/db/schema";
import { startPg } from "./_pg";

const ses = mockClient(SESv2Client);
const sns = mockClient(SNSClient);
const sts = mockClient(STSClient);

const KEYS = {
  accessKeyId: "AKIAEXAMPLEEXAMPLE",
  secretAccessKey: "s3cr3ts3cr3ts3cr3ts3cr3t",
};

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
  await pg.db
    .insert(user)
    .values({ id: "u1", name: "One", email: "u1@example.com" });
});
afterAll(async () => {
  await pg.stop();
});
afterEach(() => {
  ses.reset();
  sns.reset();
  sts.reset();
});

function happyMocks() {
  sts.on(GetCallerIdentityCommand).resolves({
    Account: "123456789012",
    Arn: "arn:aws:iam::123456789012:user/sendsprite",
  });
  ses.on(GetAccountCommand).resolves({
    ProductionAccessEnabled: false,
    SendQuota: { Max24HourSend: 200, MaxSendRate: 1 },
  });
  ses.on(CreateConfigurationSetCommand).resolves({});
  ses.on(CreateConfigurationSetEventDestinationCommand).resolves({});
  sns.on(CreateTopicCommand).resolves({
    TopicArn: "arn:aws:sns:us-east-1:123456789012:sendsprite-events",
  });
  sns
    .on(SubscribeCommand)
    .resolves({ SubscriptionArn: "pending confirmation" });
}

async function issue(region: string) {
  const { issueSetupToken } = await import("@/services/setup-tokens");
  return (
    await issueSetupToken({
      purpose: "aws_callback",
      issuedBy: "u1",
      region,
      ttlMs: 60_000,
    })
  ).token;
}

const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/setup/aws/callback/route");
  return POST(
    new Request("https://mail.acme.com/api/setup/aws/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
};

describe("POST /api/setup/aws/callback", () => {
  it("consumes a valid token and connects", async () => {
    happyMocks();
    const token = await issue("us-east-1");
    const res = await post({
      token,
      ...KEYS,
      region: "us-east-1",
      accountId: "123456789012",
    });
    expect(res.status).toBe(200);
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
    expect(await getInstanceSettings()).toMatchObject({
      awsMode: "keys",
      awsAccountId: "123456789012",
      awsRegion: "us-east-1",
    });
    // Single use: replaying the same callback is refused.
    expect((await post({ token, ...KEYS, region: "us-east-1" })).status).toBe(
      403,
    );
  });

  it("rejects an unknown token with 403 and no AWS calls", async () => {
    happyMocks();
    const res = await post({
      token: "nope-nope-nope-nope-nope",
      ...KEYS,
      region: "us-east-1",
      accountId: "1",
    });
    expect(res.status).toBe(403);
    expect(ses.commandCalls(GetAccountCommand)).toHaveLength(0);
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0);
  });

  it("rejects a region mismatch", async () => {
    happyMocks();
    const token = await issue("eu-west-1");
    const res = await post({ token, ...KEYS, region: "us-east-1" });
    expect(res.status).toBe(400);
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0);
  });

  it("rejects a malformed body", async () => {
    const { POST } = await import("@/app/api/setup/aws/callback/route");
    const res = await POST(
      new Request("https://mail.acme.com/api/setup/aws/callback", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 502 when AWS rejects the keys (stack then rolls back)", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .rejects(
        Object.assign(
          new Error("The security token included in the request is invalid."),
          { name: "InvalidClientTokenId" },
        ),
      );
    const token = await issue("us-east-1");
    const res = await post({ token, ...KEYS, region: "us-east-1" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("AWS rejected the connection"),
    });
  });
});
