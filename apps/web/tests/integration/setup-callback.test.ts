import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
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
import { disconnectTeamAwsForTests, seedTeamWithKey } from "./helpers";

const ses = mockClient(SESv2Client);
const sns = mockClient(SNSClient);
const sts = mockClient(STSClient);

const KEYS = {
  accessKeyId: "AKIAEXAMPLEEXAMPLE",
  secretAccessKey: "s3cr3ts3cr3ts3cr3ts3cr3t",
};

let pg: Awaited<ReturnType<typeof startPg>>;
let TEAM: string;
beforeAll(async () => {
  pg = await startPg();
  TEAM = (await seedTeamWithKey()).team.id;
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
/** Connecting over a live connection is refused, so start each test disconnected. */
beforeEach(async () => {
  await disconnectTeamAwsForTests(TEAM);
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
      teamId: TEAM,
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
  it("consumes a valid token and connects; replay is refused without touching AWS", async () => {
    happyMocks();
    const token = await issue("us-east-1");
    const res = await post({
      token,
      ...KEYS,
      region: "us-east-1",
      accountId: "123456789012",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, warning: null });
    const { getTeamAws } = await import("@/services/team-aws");
    // Connected on the team the token named, not on the instance.
    expect(await getTeamAws(TEAM)).toMatchObject({
      accountId: "123456789012",
      region: "us-east-1",
    });
    expect((await post({ token, ...KEYS, region: "us-east-1" })).status).toBe(
      403,
    );
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(1);
  });

  it("returns 409 and records the failure when AWS is already connected", async () => {
    happyMocks();
    const first = await issue("us-east-1");
    expect(
      (await post({ token: first, ...KEYS, region: "us-east-1" })).status,
    ).toBe(200);
    sts.resetHistory();
    const token = await issue("us-east-1");
    const res = await post({ token, ...KEYS, region: "us-east-1" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "ALREADY_CONNECTED" });
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0);
    // Token consumed: a replay is refused like any other.
    expect((await post({ token, ...KEYS, region: "us-east-1" })).status).toBe(
      403,
    );
    const { lastSetupFailure } = await import("@/services/setup-tokens");
    expect(await lastSetupFailure("aws_callback", "u1", TEAM)).toMatchObject({
      reason: expect.stringMatching(/already connected/i),
    });
  });

  it("rejects an unknown token with 403 and no AWS calls", async () => {
    happyMocks();
    const res = await post({
      token: "nope".repeat(12),
      ...KEYS,
      region: "us-east-1",
      accountId: "1",
    });
    expect(res.status).toBe(403);
    expect(ses.commandCalls(GetAccountCommand)).toHaveLength(0);
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0);
  });

  it("rejects a region mismatch and records the failure", async () => {
    happyMocks();
    const token = await issue("eu-west-1");
    const res = await post({ token, ...KEYS, region: "us-east-1" });
    expect(res.status).toBe(400);
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0);
    const { lastSetupFailure } = await import("@/services/setup-tokens");
    expect(await lastSetupFailure("aws_callback", "u1", TEAM)).toMatchObject({
      at: expect.any(Date),
      reason: expect.stringContaining("eu-west-1"),
    });
  });

  it("rejects a malformed body, short keys and unsupported regions with 400", async () => {
    const { POST } = await import("@/app/api/setup/aws/callback/route");
    const raw = await POST(
      new Request("https://mail.acme.com/api/setup/aws/callback", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(raw.status).toBe(400);
    const token = await issue("us-east-1");
    expect(
      (await post({ token, ...KEYS, region: "mars-north-1" })).status,
    ).toBe(400);
    expect(
      (
        await post({
          token,
          ...KEYS,
          secretAccessKey: "short",
          region: "us-east-1",
        })
      ).status,
    ).toBe(400);
    // Validation happens before the token is touched, so it is still usable.
    happyMocks();
    expect((await post({ token, ...KEYS, region: "us-east-1" })).status).toBe(
      200,
    );
  });

  it("returns 502 with the error code and without the secret when AWS rejects the keys; token stays burned; failure is recorded", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .rejects(
        Object.assign(
          new Error("User is not authorized to perform sts:GetCallerIdentity"),
          { name: "AccessDenied" },
        ),
      );
    const token = await issue("us-east-1");
    const res = await post({ token, ...KEYS, region: "us-east-1" });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      error: expect.stringContaining("AWS rejected the connection"),
      code: "AccessDenied",
    });
    expect(text).not.toContain(KEYS.secretAccessKey);
    expect((await post({ token, ...KEYS, region: "us-east-1" })).status).toBe(
      403,
    );
    const { lastSetupFailure } = await import("@/services/setup-tokens");
    expect(await lastSetupFailure("aws_callback", "u1", TEAM)).toMatchObject({
      reason: expect.stringContaining("not authorized"),
    });
  });

  it("returns 200 with a warning when only the SNS subscription fails", async () => {
    happyMocks();
    sns.on(SubscribeCommand).rejects(
      Object.assign(new Error("not authorized to perform: SNS:Subscribe"), {
        name: "AuthorizationError",
      }),
    );
    const token = await issue("us-east-1");
    const res = await post({ token, ...KEYS, region: "us-east-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      warning: expect.stringContaining("SES event subscription"),
    });
    const { getTeamAws } = await import("@/services/team-aws");
    expect(await getTeamAws(TEAM)).toMatchObject({
      snsSubscriptionArn: null,
    });
  });
  it("connects only the team named on the token", async () => {
    happyMocks();
    const other = (await seedTeamWithKey()).team.id;
    const token = await issue("us-east-1");
    expect(
      (await post({ token, ...KEYS, region: "us-east-1" })).status,
    ).toBe(200);
    const { getTeamAws } = await import("@/services/team-aws");
    expect(await getTeamAws(TEAM)).not.toBeNull();
    // A stack created for one team cannot connect into another.
    expect(await getTeamAws(other)).toBeNull();
  });
});

