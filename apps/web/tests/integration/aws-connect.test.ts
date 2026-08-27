import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  CloudFormationClient,
  DeleteStackCommand,
} from "@aws-sdk/client-cloudformation";
import { eq } from "drizzle-orm";
import {
  SESv2Client,
  GetAccountCommand,
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  PutAccountDetailsCommand,
  UpdateConfigurationSetEventDestinationCommand,
} from "@aws-sdk/client-sesv2";
import {
  SNSClient,
  CreateTopicCommand,
  SubscribeCommand,
  UnsubscribeCommand,
} from "@aws-sdk/client-sns";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { auditLog, teamAws } from "@/db/schema";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

const ses = mockClient(SESv2Client);
const sns = mockClient(SNSClient);
const sts = mockClient(STSClient);
const cfn = mockClient(CloudFormationClient);

const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:sendsprite-events";
const SUB_ARN = `${TOPIC_ARN}:6b0e71bd-7e97-4d97-80ce-4a0994e55286`;
const KEYS = {
  accessKeyId: "AKIAEXAMPLEEXAMPLE",
  secretAccessKey: "s3cr3ts3cr3ts3cr3ts3cr3t",
  region: "us-east-1",
};
const awsErr = (name: string, message: string) =>
  Object.assign(new Error(message), { name });
/** What the one-click callback passes on; manual keys pass nothing. */
const STACK = {
  stackId:
    "arn:aws:cloudformation:us-east-1:123456789012:stack/sendsprite-connect-acme/3f1c2a10-9b7e-11ef-8c2d-0a1b2c3d4e5f",
  serviceRoleArn: "arn:aws:iam::123456789012:role/sendsprite-connect-acme-cfn",
};

let pg: Awaited<ReturnType<typeof startPg>>;
/** The team under test, and the slug its AWS resource names derive from. */
let TEAM: string;
const SLUG = "acme";
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
  TEAM = (await seedTeamWithKey()).team.id;
});
afterAll(async () => {
  await pg.stop();
});
/** Every test starts from a disconnected team and sets its own precondition. */
beforeEach(async () => {
  const { teamAws } = await import("@/db/schema");
  await pg.db.delete(teamAws);
  await pg.db.delete(auditLog);
});
afterEach(() => {
  ses.reset();
  sns.reset();
  sts.reset();
  cfn.reset();
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
  sns.on(SubscribeCommand).resolves({ SubscriptionArn: SUB_ARN });
}

/** The team's connection row, or null when it is disconnected. */
async function conn() {
  const { getTeamAws } = await import("@/services/team-aws");
  return getTeamAws(TEAM);
}
/** This team's audit rows, optionally just those with `action`. */
async function audits(action?: string) {
  return pg.db
    .select()
    .from(auditLog)
    .where(action ? eq(auditLog.action, action) : eq(auditLog.teamId, TEAM));
}

describe("connectWithKeys", () => {
  it("returns a Result error (no state change) when credentials are rejected", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .rejects(
        awsErr(
          "InvalidClientTokenId",
          "The security token included in the request is invalid.",
        ),
      );
    const { connectWithKeys } = await import("@/services/aws-connect");
    const res = await connectWithKeys(
      TEAM,
      SLUG,
      { ...KEYS, accessKeyId: "AKIABADBADBADBAD" },
      { userId: "u1" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/security token/i);
    expect(await conn()).toBeNull();
  });
  it("rejects malformed input (short keys, unsupported region) without calling AWS", async () => {
    const { connectWithKeys } = await import("@/services/aws-connect");
    for (const input of [
      { accessKeyId: "short", secretAccessKey: "short", region: "us-east-1" },
      { ...KEYS, region: "mars-north-1" },
    ]) {
      expect(
        (await connectWithKeys(TEAM, SLUG, input, { userId: "u1" })).ok,
      ).toBe(false);
    }
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0);
  });
  it("verifies, stores encrypted keys, provisions SES infra, records account", async () => {
    happyMocks();
    const { connectWithKeys, EVENT_TYPES } =
      await import("@/services/aws-connect");
    const res = await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" });
    expect(res).toEqual({
      ok: true,
      data: { accountId: "123456789012", status: "sandbox" },
    });
    const { getTeamAwsSecrets } = await import("@/services/team-aws");
    const s = await conn();
    expect(s).toMatchObject({
      region: "us-east-1",
      accountId: "123456789012",
      configSet: "sendsprite-acme",
      snsTopicArn: TOPIC_ARN,
      snsSubscriptionArn: SUB_ARN,
      sesAccountStatus: "sandbox",
      sesDailyQuota: 200,
      sesMaxSendRate: 1,
    });
    expect(s?.connectedAt).toBeInstanceOf(Date);
    expect(s?.accessKeyEnc).toMatch(/^v1\./);
    expect(await getTeamAwsSecrets(TEAM)).toMatchObject({
      accessKey: KEYS.accessKeyId,
      secret: KEYS.secretAccessKey,
    });
    const dest = ses.commandCalls(
      CreateConfigurationSetEventDestinationCommand,
    )[0]!.args[0].input;
    expect(dest).toMatchObject({
      ConfigurationSetName: "sendsprite-acme",
      EventDestination: {
        Enabled: true,
        SnsDestination: { TopicArn: TOPIC_ARN },
      },
    });
    expect(dest.EventDestination?.MatchingEventTypes).toEqual([...EVENT_TYPES]);
    expect(sns.commandCalls(SubscribeCommand)[0]!.args[0].input).toEqual({
      TopicArn: TOPIC_ARN,
      Protocol: "https",
      Endpoint: `https://mail.acme.com/api/webhooks/ses/${TEAM}`,
      ReturnSubscriptionArn: true,
    });
    // One audited write for the connection; the subscription ARN is bookkeeping.
    expect(await audits()).toHaveLength(1);
    expect(await audits("aws.connect")).toHaveLength(1);
  });
  it("persists the topic ARN before subscribing (confirmation POST can race Subscribe)", async () => {
    happyMocks();
    sns.on(SubscribeCommand).callsFake(async () => {
      expect(await conn()).toMatchObject({
        snsTopicArn: TOPIC_ARN,
        snsSubscriptionArn: null,
      });
      return { SubscriptionArn: SUB_ARN };
    });
    const { connectWithKeys } = await import("@/services/aws-connect");
    expect((await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok).toBe(
      true,
    );
    expect(sns.commandCalls(SubscribeCommand)).toHaveLength(1);
    expect((await conn())?.snsSubscriptionArn).toBe(SUB_ARN);
  });
  it("waits out IAM propagation: STS rejects twice, then connects", async () => {
    happyMocks();
    sts
      .on(GetCallerIdentityCommand)
      .rejectsOnce(awsErr("InvalidClientTokenId", "invalid token"))
      .rejectsOnce(awsErr("InvalidSignatureException", "bad signature"))
      .resolves({ Account: "123456789012" });
    const { connectWithKeys, setSleepForTests } =
      await import("@/services/aws-connect");
    const slept: number[] = [];
    setSleepForTests(async (ms) => {
      slept.push(ms);
    });
    try {
      expect(
        (await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok,
      ).toBe(true);
    } finally {
      setSleepForTests((ms) => new Promise((r) => setTimeout(r, ms)));
    }
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(3);
    expect(slept).toEqual([3000, 3000]);
    expect(await conn()).not.toBeNull();
  });
  it("gives up after 5 propagation failures (≤ 15 s budget) with no state and the error code", async () => {
    happyMocks();
    sts
      .on(GetCallerIdentityCommand)
      .rejects(awsErr("InvalidClientTokenId", "invalid token"));
    const { connectWithKeys, setSleepForTests } =
      await import("@/services/aws-connect");
    setSleepForTests(async () => {});
    try {
      const res = await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" });
      expect(res).toMatchObject({ ok: false, code: "InvalidClientTokenId" });
    } finally {
      setSleepForTests((ms) => new Promise((r) => setTimeout(r, ms)));
    }
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(5);
    expect(await conn()).toBeNull();
    expect(await audits()).toHaveLength(0);
  });
  it("refuses to connect over a live connection (disconnect first)", async () => {
    happyMocks();
    const { connectWithKeys } = await import("@/services/aws-connect");
    expect((await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok).toBe(
      true,
    );
    sts.resetHistory();
    const refused = {
      ok: false,
      code: "ALREADY_CONNECTED",
      error: expect.stringMatching(/already connected/i),
    };
    expect(
      await connectWithKeys(
        TEAM,
        SLUG,
        { ...KEYS, accessKeyId: "AKIAOTHEROTHEROTHER" },
        { userId: "u1" },
      ),
    ).toEqual(refused);
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0);
    expect(await conn()).toMatchObject({
      region: "us-east-1",
    });
    expect(await audits()).toHaveLength(1);
  });
  it("stays connected with a warning when Subscribe fails (no rollback trap)", async () => {
    happyMocks();
    sns
      .on(SubscribeCommand)
      .rejects(awsErr("AuthorizationError", "not authorized: SNS:Subscribe"));
    const { connectWithKeys } = await import("@/services/aws-connect");
    const res = await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.warning).toContain("SES event subscription");
    expect(await conn()).toMatchObject({
      snsTopicArn: TOPIC_ARN,
      snsSubscriptionArn: null,
    });
  });
  it("converges when the config set and event destination already exist", async () => {
    happyMocks();
    ses
      .on(CreateConfigurationSetCommand)
      .rejects(awsErr("AlreadyExistsException", "exists"));
    ses
      .on(CreateConfigurationSetEventDestinationCommand)
      .rejects(awsErr("AlreadyExistsException", "exists"));
    ses.on(UpdateConfigurationSetEventDestinationCommand).resolves({});
    const { connectWithKeys } = await import("@/services/aws-connect");
    expect((await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok).toBe(
      true,
    );
    const update = ses.commandCalls(
      UpdateConfigurationSetEventDestinationCommand,
    );
    expect(update).toHaveLength(1);
    expect(update[0]!.args[0].input).toEqual(
      ses.commandCalls(CreateConfigurationSetEventDestinationCommand)[0]!
        .args[0].input,
    );
  });
  it("leaves the instance disconnected when provisioning fails part-way", async () => {
    happyMocks();
    sns
      .on(CreateTopicCommand)
      .rejects(
        awsErr(
          "AccessDeniedException",
          "User is not authorized to perform: sns:CreateTopic",
        ),
      );
    const { connectWithKeys } = await import("@/services/aws-connect");
    const res = await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/sns:CreateTopic/);
      expect(res.error).not.toContain(KEYS.secretAccessKey);
    }
    // Nothing persisted: the row's absence is the disconnected state.
    expect(await conn()).toBeNull();
    expect(await audits()).toHaveLength(0);
  });
  it("skips the SNS subscription when APP_URL is not https (local dev)", async () => {
    happyMocks();
    const { resetEnvCache } = await import("@/env.schema");
    process.env.APP_URL = "http://localhost:3000";
    resetEnvCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { connectWithKeys } = await import("@/services/aws-connect");
      expect(
        (await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok,
      ).toBe(true);
      expect(sns.commandCalls(SubscribeCommand)).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/https/i));
      expect(await conn()).toMatchObject({
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
  async function connected() {
    happyMocks();
    const { connectWithKeys } = await import("@/services/aws-connect");
    expect((await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok).toBe(
      true,
    );
    await pg.db.delete(auditLog);
  }
  it("submits details and flips status to requested", async () => {
    await connected();
    ses.on(PutAccountDetailsCommand).resolves({});
    ses.on(GetAccountCommand).resolves({
      ProductionAccessEnabled: false,
      Details: { ReviewDetails: { Status: "PENDING" } },
      SendQuota: { Max24HourSend: 200, MaxSendRate: 1 },
    });
    const { requestProductionAccess } = await import("@/services/aws-connect");
    const res = await requestProductionAccess(
      TEAM,
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
    expect(await conn()).toMatchObject({
      sesAccountStatus: "requested",
      sesReviewStatus: "PENDING",
    });
    expect(await audits()).toHaveLength(1);
    expect(await audits("ses.production.request")).toHaveLength(1);
  });
  it("audits a production request even when SES reports the account unchanged", async () => {
    await connected();
    ses.on(PutAccountDetailsCommand).resolves({});
    // Same values happyMocks() connected with: nothing changes.
    const { requestProductionAccess } = await import("@/services/aws-connect");
    const res = await requestProductionAccess(
      TEAM,
      {
        websiteUrl: "https://acme.com",
        mailType: "TRANSACTIONAL",
        useCase: "Order receipts and password resets.",
      },
      { userId: "u1" },
    );
    expect(res).toEqual({ ok: true, data: { status: "sandbox" } });
    expect(await audits()).toHaveLength(1);
    expect(await audits("ses.production.request")).toHaveLength(1);
  });
  it("rejects an invalid request before calling SES", async () => {
    const { requestProductionAccess } = await import("@/services/aws-connect");
    const res = await requestProductionAccess(
      TEAM,
      { websiteUrl: "acme", mailType: "OTHER", useCase: "short" },
      { userId: "u1" },
    );
    expect(res.ok).toBe(false);
    expect(ses.commandCalls(PutAccountDetailsCommand)).toHaveLength(0);
  });
  it("says so when the request went through but the status read failed", async () => {
    await connected();
    ses.on(PutAccountDetailsCommand).resolves({});
    ses
      .on(GetAccountCommand)
      .rejects(awsErr("TooManyRequestsException", "Rate exceeded"));
    const { requestProductionAccess } = await import("@/services/aws-connect");
    const res = await requestProductionAccess(
      TEAM,
      {
        websiteUrl: "https://acme.com",
        mailType: "MARKETING",
        useCase: "Weekly newsletter for opted-in subscribers.",
      },
      { userId: "u1" },
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringMatching(/^Request submitted, but .*Rate exceeded/),
    });
    expect(ses.commandCalls(PutAccountDetailsCommand)).toHaveLength(1);
  });
  it("refreshSesAccount audits a change once and stays quiet when nothing changed", async () => {
    await connected();
    ses.on(GetAccountCommand).resolves({
      ProductionAccessEnabled: true,
      Details: { ReviewDetails: { Status: "GRANTED" } },
      SendQuota: { Max24HourSend: 50000, MaxSendRate: 14 },
    });
    const { refreshSesAccount } = await import("@/services/aws-connect");
    expect(await refreshSesAccount(TEAM, { userId: "u1" })).toEqual({
      ok: true,
      data: { status: "production" },
    });
    const first = await conn();
    expect(first).toMatchObject({
      sesAccountStatus: "production",
      sesReviewStatus: "GRANTED",
      sesDailyQuota: 50000,
      sesMaxSendRate: 14,
    });
    expect(await audits()).toHaveLength(1);
    expect(await audits("ses.account.refresh")).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 5));
    expect((await refreshSesAccount(TEAM)).ok).toBe(true);
    const second = await conn();
    expect(second!.sesLastCheckedAt!.getTime()).toBeGreaterThan(
      first!.sesLastCheckedAt!.getTime(),
    );
    expect(await audits()).toHaveLength(1);
  });
});

/**
 * The stack deleted in the console, the key revoked, the policy pulled: the
 * row still says "connected" in every column, and the dashboard used to
 * print exactly that until someone noticed the failed emails. These pin the
 * one column that says otherwise.
 */
describe("credential failures", () => {
  /** Past the propagation grace, so a refusal counts. */
  const ageConnection = () =>
    pg.db
      .update(teamAws)
      .set({ connectedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(teamAws.teamId, TEAM));
  const dead = () =>
    ses
      .on(GetAccountCommand)
      .rejects(
        awsErr(
          "UnrecognizedClientException",
          "The security token included in the request is invalid.",
        ),
      );

  it("a refused refresh records lastError, audited once; a working one clears it, audited", async () => {
    happyMocks();
    const { connectWithKeys, refreshSesAccount } =
      await import("@/services/aws-connect");
    expect((await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok).toBe(
      true,
    );
    await ageConnection();
    dead();
    expect((await refreshSesAccount(TEAM)).ok).toBe(false);
    expect((await conn())?.lastError).toMatch(
      /^UnrecognizedClientException: The security token/,
    );
    expect(await audits("aws.credentials_failed")).toHaveLength(1);
    // Same again: the message is refreshed, nothing new is audited.
    expect((await refreshSesAccount(TEAM)).ok).toBe(false);
    expect(await audits("aws.credentials_failed")).toHaveLength(1);
    // Reconnected in the console (or the key restored): back to healthy.
    ses.reset();
    happyMocks();
    expect((await refreshSesAccount(TEAM)).ok).toBe(true);
    expect((await conn())?.lastError).toBeNull();
    expect(await audits("aws.credentials_restored")).toHaveLength(1);
  });

  it("a refusal inside the propagation grace after connect is not a dead connection", async () => {
    happyMocks();
    const { connectWithKeys, refreshSesAccount } =
      await import("@/services/aws-connect");
    expect((await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok).toBe(
      true,
    );
    dead();
    expect((await refreshSesAccount(TEAM)).ok).toBe(false);
    expect((await conn())?.lastError).toBeNull();
    expect(await audits("aws.credentials_failed")).toHaveLength(0);
  });

  it("a throttle or network error is not recorded as a credential failure", async () => {
    happyMocks();
    const { connectWithKeys, refreshSesAccount } =
      await import("@/services/aws-connect");
    expect((await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok).toBe(
      true,
    );
    await ageConnection();
    ses
      .on(GetAccountCommand)
      .rejects(awsErr("TooManyRequestsException", "Rate exceeded"));
    expect((await refreshSesAccount(TEAM)).ok).toBe(false);
    expect((await conn())?.lastError).toBeNull();
  });

  it("getTeamAwsChecked asks AWS only when the last check is stale", async () => {
    happyMocks();
    const { connectWithKeys, getTeamAwsChecked } =
      await import("@/services/aws-connect");
    expect((await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok).toBe(
      true,
    );
    // Connect just checked: believed without a call.
    ses.resetHistory();
    expect((await getTeamAwsChecked(TEAM))?.lastError).toBeNull();
    expect(ses.commandCalls(GetAccountCommand)).toHaveLength(0);
    // Ten minutes on, with the key gone: the page learns it now, not at the
    // next hourly tick.
    await pg.db
      .update(teamAws)
      .set({
        connectedAt: new Date(Date.now() - 10 * 60_000),
        sesLastCheckedAt: new Date(Date.now() - 10 * 60_000),
      })
      .where(eq(teamAws.teamId, TEAM));
    dead();
    const row = await getTeamAwsChecked(TEAM);
    expect(ses.commandCalls(GetAccountCommand)).toHaveLength(1);
    expect(row?.lastError).toMatch(/UnrecognizedClientException/);
    // And is not asked again for the next five minutes.
    ses.resetHistory();
    await getTeamAwsChecked(TEAM);
    expect(ses.commandCalls(GetAccountCommand)).toHaveLength(0);
  });
});

describe("disconnectAws", () => {
  it("unsubscribes, forgets credentials and SES state, then refuses a second disconnect", async () => {
    happyMocks();
    sns.on(UnsubscribeCommand).resolves({});
    const { connectWithKeys, disconnectAws } =
      await import("@/services/aws-connect");
    expect((await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok).toBe(
      true,
    );
    // Pasted keys: nothing for us to delete, and the outcome says so
    // rather than pretending the revoke was complete.
    expect(await disconnectAws(TEAM, { userId: "u1" })).toEqual({
      ok: true,
      data: {
        kind: "stack_orphaned",
        reason: "no_stack",
        stackName: null,
        consoleUrl: null,
      },
    });
    expect(cfn.commandCalls(DeleteStackCommand)).toHaveLength(0);
    expect(sns.commandCalls(UnsubscribeCommand)[0]!.args[0].input).toEqual({
      SubscriptionArn: SUB_ARN,
    });
    // Disconnecting deletes the row rather than nulling a dozen columns:
    // the row's existence is the connection.
    expect(await conn()).toBeNull();
    expect((await disconnectAws(TEAM, { userId: "u1" })).ok).toBe(false);
    expect((await audits()).map((a) => a.action)).toEqual([
      "aws.connect",
      "aws.disconnect",
    ]);
  });
  it("still disconnects when Unsubscribe fails", async () => {
    happyMocks();
    sns
      .on(UnsubscribeCommand)
      .rejects(awsErr("AuthorizationError", "not authorized"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { connectWithKeys, disconnectAws } =
        await import("@/services/aws-connect");
      expect(
        (await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok,
      ).toBe(true);
      expect((await disconnectAws(TEAM, { userId: "u1" })).ok).toBe(true);
      expect(await conn()).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("disconnectAws with a one-click stack", () => {
  async function connectedWithStack() {
    happyMocks();
    const { connectWithKeys } = await import("@/services/aws-connect");
    const res = await connectWithKeys(
      TEAM,
      SLUG,
      KEYS,
      { userId: "u1" },
      STACK,
    );
    expect(res.ok).toBe(true);
    expect(await conn()).toMatchObject({
      stackId: STACK.stackId,
      stackServiceRoleArn: STACK.serviceRoleArn,
    });
  }

  it("deletes the stack through its service role, after unsubscribing, and reports it", async () => {
    await connectedWithStack();
    sns.on(UnsubscribeCommand).resolves({});
    cfn.on(DeleteStackCommand).resolves({});
    const { disconnectAws } = await import("@/services/aws-connect");
    const res = await disconnectAws(TEAM, { userId: "u1" });
    expect(res).toEqual({
      ok: true,
      data: {
        kind: "stack_deleting",
        stackName: "sendsprite-connect-acme",
        consoleUrl: expect.stringContaining(
          "https://us-east-1.console.aws.amazon.com/cloudformation/",
        ),
      },
    });
    // RoleARN is the whole point: without it CloudFormation deletes on a
    // session minted from the key the stack's own Lambda is about to remove.
    expect(cfn.commandCalls(DeleteStackCommand)[0]!.args[0].input).toEqual({
      StackName: STACK.stackId,
      RoleARN: STACK.serviceRoleArn,
    });
    // Unsubscribe needs live credentials, so it must run before the stack
    // starts revoking them.
    const calls = [
      ...sns.commandCalls(UnsubscribeCommand).map(() => "unsubscribe"),
      ...cfn.commandCalls(DeleteStackCommand).map(() => "delete"),
    ];
    expect(calls).toEqual(["unsubscribe", "delete"]);
    expect(await conn()).toBeNull();
  });

  it("AccessDenied (a stack older than the service role) → orphaned, row still gone", async () => {
    await connectedWithStack();
    sns.on(UnsubscribeCommand).resolves({});
    cfn
      .on(DeleteStackCommand)
      .rejects(
        awsErr("AccessDenied", "not authorized to perform iam:PassRole"),
      );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { disconnectAws } = await import("@/services/aws-connect");
      const res = await disconnectAws(TEAM, { userId: "u1" });
      expect(res.ok).toBe(true);
      if (res.ok)
        expect(res.data).toMatchObject({
          kind: "stack_orphaned",
          reason: "access_denied",
          stackName: "sendsprite-connect-acme",
          consoleUrl: expect.stringContaining("stackId="),
        });
      // The owner asked to revoke; a teardown that could not happen must not
      // keep the team connected to those credentials.
      expect(await conn()).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("any other DeleteStack failure → orphaned with the reason, row still gone", async () => {
    await connectedWithStack();
    sns.on(UnsubscribeCommand).resolves({});
    cfn
      .on(DeleteStackCommand)
      .rejects(awsErr("ValidationError", "Stack is in DELETE_IN_PROGRESS"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { disconnectAws } = await import("@/services/aws-connect");
      const res = await disconnectAws(TEAM, { userId: "u1" });
      expect(res.ok).toBe(true);
      if (res.ok)
        expect(res.data).toMatchObject({
          kind: "stack_orphaned",
          reason: "error",
          detail: "Stack is in DELETE_IN_PROGRESS",
        });
      expect(await conn()).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("org-scoped AWS resource names", () => {
  it("names the config set, topic and webhook path from the org slug", async () => {
    happyMocks();
    const { connectWithKeys } = await import("@/services/aws-connect");
    expect((await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok).toBe(
      true,
    );
    expect((await conn())?.configSet).toBe("sendsprite-acme");
    expect(
      sns.commandCalls(CreateTopicCommand)[0]!.args[0].input,
    ).toMatchObject({ Name: "sendsprite-events-acme" });
    expect(sns.commandCalls(SubscribeCommand)[0]!.args[0].input).toMatchObject({
      Endpoint: `https://mail.acme.com/api/webhooks/ses/${TEAM}`,
    });
  });

  /**
   * The dangerous case. Two orgs may point at one AWS account; a shared
   * configuration set would make CreateConfigurationSetEventDestination take
   * its AlreadyExists branch and *update* the destination, repointing the
   * first org's SES events at the second org's topic.
   */
  it("gives two orgs on one AWS account distinct, non-overwriting resources", async () => {
    happyMocks();
    const other = (await seedTeamWithKey()).team.id;
    const OTHER_TOPIC = "arn:aws:sns:us-east-1:123456789012:sendsprite-beta";
    sns
      .on(CreateTopicCommand, { Name: "sendsprite-events-acme" })
      .resolves({ TopicArn: TOPIC_ARN })
      .on(CreateTopicCommand, { Name: "sendsprite-events-beta-co" })
      .resolves({ TopicArn: OTHER_TOPIC });
    const { connectWithKeys } = await import("@/services/aws-connect");
    // Same credentials, same AWS account, different org.
    expect((await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok).toBe(
      true,
    );
    expect(
      (await connectWithKeys(other, "beta-co", KEYS, { userId: "u1" })).ok,
    ).toBe(true);

    const { getTeamAws } = await import("@/services/team-aws");
    const a = await getTeamAws(TEAM);
    const b = await getTeamAws(other);
    expect(a?.configSet).toBe("sendsprite-acme");
    expect(b?.configSet).toBe("sendsprite-beta-co");
    expect(b?.snsTopicArn).not.toBe(a?.snsTopicArn);

    // Each event destination names its own configuration set, so neither
    // connect repointed the other's.
    const dests = ses
      .commandCalls(CreateConfigurationSetEventDestinationCommand)
      .map((c) => c.args[0].input.ConfigurationSetName);
    expect(dests).toEqual(["sendsprite-acme", "sendsprite-beta-co"]);
    expect(new Set(dests).size).toBe(dests.length);
  });

  it("keeps the stored names when the org slug later changes", async () => {
    happyMocks();
    const { connectWithKeys } = await import("@/services/aws-connect");
    expect((await connectWithKeys(TEAM, SLUG, KEYS, { userId: "u1" })).ok).toBe(
      true,
    );
    const { organization, teamAws } = await import("@/db/schema");
    await pg.db
      .update(organization)
      .set({ slug: "renamed-co" })
      .where(eq(organization.id, TEAM));
    // Read past React.cache: the point is what is on disk, not what a request
    // memoised.
    const [row] = await pg.db
      .select()
      .from(teamAws)
      .where(eq(teamAws.teamId, TEAM));
    expect(row?.configSet).toBe("sendsprite-acme");
    expect(row?.snsTopicArn).toBe(TOPIC_ARN);
  });
});
