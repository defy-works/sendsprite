import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SESv2Client,
  GetAccountCommand,
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  PutAccountDetailsCommand,
} from "@aws-sdk/client-sesv2";
import {
  SNSClient,
  CreateTopicCommand,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { startPg } from "./_pg";

const ses = mockClient(SESv2Client);
const sns = mockClient(SNSClient);
const sts = mockClient(STSClient);

const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:sendsprite-events";
const KEYS = {
  accessKeyId: "AKIAEXAMPLEEXAMPLE",
  secretAccessKey: "s3cr3ts3cr3ts3cr3ts3cr3t",
  region: "us-east-1",
};

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
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
  sns.on(CreateTopicCommand).resolves({ TopicArn: TOPIC_ARN });
  sns
    .on(SubscribeCommand)
    .resolves({ SubscriptionArn: "pending confirmation" });
}

describe("connectWithKeys", () => {
  it("returns a Result error (no state change) when credentials are rejected", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .rejects(
        Object.assign(
          new Error("The security token included in the request is invalid."),
          { name: "InvalidClientTokenId" },
        ),
      );
    const { connectWithKeys } = await import("@/services/aws-connect");
    const res = await connectWithKeys(
      { ...KEYS, accessKeyId: "AKIABADBADBADBAD" },
      { userId: "u1" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/security token/i);
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
    expect(await getInstanceSettings()).toMatchObject({
      awsMode: "none",
      awsAccessKeyEnc: null,
    });
  });
  it("rejects malformed input without calling AWS", async () => {
    const { connectWithKeys } = await import("@/services/aws-connect");
    const res = await connectWithKeys(
      { accessKeyId: "short", secretAccessKey: "short", region: "" },
      { userId: "u1" },
    );
    expect(res.ok).toBe(false);
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0);
  });
  it("verifies, stores encrypted keys, provisions SES infra, records account", async () => {
    happyMocks();
    const { connectWithKeys } = await import("@/services/aws-connect");
    const res = await connectWithKeys(KEYS, { userId: "u1" });
    expect(res).toEqual({
      ok: true,
      data: { accountId: "123456789012", status: "sandbox" },
    });
    const { getInstanceSettings, getDecryptedSecrets } =
      await import("@/services/instance-settings");
    const s = await getInstanceSettings();
    expect(s).toMatchObject({
      awsMode: "keys",
      awsRegion: "us-east-1",
      awsAccountId: "123456789012",
      sesConfigSet: "sendsprite",
      snsTopicArn: TOPIC_ARN,
      snsSubscriptionArn: "pending confirmation",
      sesAccountStatus: "sandbox",
      sesDailyQuota: 200,
      sesMaxSendRate: 1,
    });
    expect(s.awsConnectedAt).toBeInstanceOf(Date);
    expect(s.awsAccessKeyEnc).toMatch(/^v1\./);
    expect(await getDecryptedSecrets()).toMatchObject({
      awsAccessKey: KEYS.accessKeyId,
      awsSecret: KEYS.secretAccessKey,
    });
    expect(
      ses.commandCalls(CreateConfigurationSetEventDestinationCommand)[0]!
        .args[0].input,
    ).toMatchObject({
      ConfigurationSetName: "sendsprite",
      EventDestination: {
        Enabled: true,
        SnsDestination: { TopicArn: TOPIC_ARN },
      },
    });
    expect(sns.commandCalls(SubscribeCommand)[0]!.args[0].input).toMatchObject({
      TopicArn: TOPIC_ARN,
      Protocol: "https",
      Endpoint: "https://mail.acme.com/api/webhooks/ses",
    });
  });
  it("is idempotent when the configuration set already exists", async () => {
    happyMocks();
    ses
      .on(CreateConfigurationSetCommand)
      .rejects(
        Object.assign(new Error("exists"), { name: "AlreadyExistsException" }),
      );
    ses
      .on(CreateConfigurationSetEventDestinationCommand)
      .rejects(
        Object.assign(new Error("exists"), { name: "AlreadyExistsException" }),
      );
    const { connectWithKeys } = await import("@/services/aws-connect");
    expect((await connectWithKeys(KEYS, { userId: "u1" })).ok).toBe(true);
  });
  it("skips the SNS subscription when APP_URL is not https (local dev)", async () => {
    happyMocks();
    const { resetEnvCache } = await import("@/env.schema");
    process.env.APP_URL = "http://localhost:3000";
    resetEnvCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { connectWithKeys } = await import("@/services/aws-connect");
      expect((await connectWithKeys(KEYS, { userId: "u1" })).ok).toBe(true);
      expect(sns.commandCalls(SubscribeCommand)).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/https/i));
      const { getInstanceSettings } =
        await import("@/services/instance-settings");
      expect(await getInstanceSettings()).toMatchObject({
        snsTopicArn: TOPIC_ARN,
        snsSubscriptionArn: null,
      });
    } finally {
      warn.mockRestore();
      process.env.APP_URL = "https://mail.acme.com";
      resetEnvCache();
    }
  });
});

describe("requestProductionAccess / refreshSesAccount", () => {
  it("submits details and flips status to requested", async () => {
    happyMocks();
    ses.on(PutAccountDetailsCommand).resolves({});
    ses.on(GetAccountCommand).resolves({
      ProductionAccessEnabled: false,
      Details: { ReviewDetails: { Status: "PENDING" } },
      SendQuota: { Max24HourSend: 200, MaxSendRate: 1 },
    });
    const { requestProductionAccess } = await import("@/services/aws-connect");
    const res = await requestProductionAccess(
      {
        websiteUrl: "https://acme.com",
        mailType: "TRANSACTIONAL",
        useCase: "Order receipts and password resets.",
        contactEmail: "ops@acme.com",
      },
      { userId: "u1" },
    );
    expect(res).toEqual({ ok: true, data: { status: "requested" } });
    expect(
      ses.commandCalls(PutAccountDetailsCommand)[0]!.args[0].input,
    ).toMatchObject({
      MailType: "TRANSACTIONAL",
      WebsiteURL: "https://acme.com",
      ProductionAccessEnabled: true,
      AdditionalContactEmailAddresses: ["ops@acme.com"],
    });
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
    expect(await getInstanceSettings()).toMatchObject({
      sesAccountStatus: "requested",
      sesReviewStatus: "PENDING",
    });
  });
  it("rejects an invalid request before calling SES", async () => {
    const { requestProductionAccess } = await import("@/services/aws-connect");
    const res = await requestProductionAccess(
      { websiteUrl: "acme", mailType: "OTHER", useCase: "short" },
      { userId: "u1" },
    );
    expect(res.ok).toBe(false);
    expect(ses.commandCalls(PutAccountDetailsCommand)).toHaveLength(0);
  });
  it("refreshSesAccount reports production once granted", async () => {
    ses.on(GetAccountCommand).resolves({
      ProductionAccessEnabled: true,
      Details: { ReviewDetails: { Status: "GRANTED" } },
      SendQuota: { Max24HourSend: 50000, MaxSendRate: 14 },
    });
    const { refreshSesAccount } = await import("@/services/aws-connect");
    expect(await refreshSesAccount()).toEqual({
      ok: true,
      data: { status: "production" },
    });
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
    expect(await getInstanceSettings()).toMatchObject({
      sesAccountStatus: "production",
      sesReviewStatus: "GRANTED",
      sesDailyQuota: 50000,
      sesMaxSendRate: 14,
    });
  });
});

describe("detectInstanceRole", () => {
  it("connects with instance role when the default chain works", async () => {
    happyMocks();
    const { detectInstanceRole } = await import("@/services/aws-connect");
    const res = await detectInstanceRole("us-east-1", { userId: "u1" });
    expect(res).toMatchObject({
      ok: true,
      data: { accountId: "123456789012" },
    });
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
    expect(await getInstanceSettings()).toMatchObject({
      awsMode: "instance_role",
      awsAccessKeyEnc: null,
      awsSecretEnc: null,
    });
  });
  it("returns ok:false without throwing when no credentials are available", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .rejects(
        Object.assign(
          new Error("Could not load credentials from any providers"),
          { name: "CredentialsProviderError" },
        ),
      );
    const { detectInstanceRole } = await import("@/services/aws-connect");
    expect((await detectInstanceRole("us-east-1", { userId: "u1" })).ok).toBe(
      false,
    );
  });
});

describe("disconnectAws", () => {
  it("forgets credentials and SES state, then refuses a second disconnect", async () => {
    const { disconnectAws } = await import("@/services/aws-connect");
    expect(await disconnectAws({ userId: "u1" })).toEqual({
      ok: true,
      data: undefined,
    });
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
    expect(await getInstanceSettings()).toMatchObject({
      awsMode: "none",
      awsAccountId: null,
      awsAccessKeyEnc: null,
      snsTopicArn: null,
      sesConfigSet: null,
      sesAccountStatus: null,
    });
    expect((await disconnectAws({ userId: "u1" })).ok).toBe(false);
  });
});
