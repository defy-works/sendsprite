import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ConfirmSubscriptionCommand, SNSClient } from "@aws-sdk/client-sns";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

vi.mock("@/lib/sns-message", () => ({
  verifySnsMessage: async (raw: unknown) => raw,
}));

const TOPIC = "arn:aws:sns:us-east-1:1:sendsprite-events";
const SUB = `${TOPIC}:sub-1`;
const sns = mockClient(SNSClient);

let pg: Awaited<ReturnType<typeof startPg>>;
let TEAM: string;
let OTHER: string;
let fetchCalls: { url: string; init?: RequestInit }[] = [];
let fetchBody = "";
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
  TEAM = (await seedTeamWithKey()).team.id;
  OTHER = (await seedTeamWithKey()).team.id;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(fetchBody, { status: 200 });
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pg.stop();
});
beforeEach(() => {
  sns.reset();
  fetchCalls = [];
  fetchBody = `<ConfirmSubscriptionResponse><ConfirmSubscriptionResult><SubscriptionArn>${SUB}</SubscriptionArn></ConfirmSubscriptionResult></ConfirmSubscriptionResponse>`;
});

const teamAwsSvc = () => import("@/services/team-aws");
const route = () => import("@/app/api/webhooks/ses/[teamId]/route");
/** The team's connection row straight from the database, past React.cache. */
const conn = async (teamId = TEAM) => {
  const { teamAws } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await pg.db
    .select()
    .from(teamAws)
    .where(eq(teamAws.teamId, teamId));
  return row ?? null;
};
const post = async (
  body: { Type: string } & Record<string, unknown>,
  teamId = TEAM,
) => {
  const { POST } = await route();
  return POST(
    new Request(`https://mail.acme.com/api/webhooks/ses/${teamId}`, {
      method: "POST",
      headers: {
        "x-amz-sns-message-type": body.Type,
        "content-type": "text/plain",
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ teamId }) },
  );
};
const confirmation = (over: Record<string, unknown> = {}) => ({
  Type: "SubscriptionConfirmation",
  TopicArn: TOPIC,
  Token: "t",
  SubscribeURL:
    "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t",
  MessageId: "m1",
  ...over,
});

// Ordered: connected (SDK path) first, then disconnected (fallback path).
describe("POST /api/webhooks/ses/[teamId]", () => {
  it("confirms via the SDK with AuthenticateOnUnsubscribe when AWS is connected", async () => {
    const { updateTeamAws } = await teamAwsSvc();
    await updateTeamAws(TEAM, {
      region: "us-east-1",
      accessKey: "AKIAEXAMPLEEXAMPLE",
      secret: "s3cr3ts3cr3ts3cr3ts3cr3t",
      configSet: "sendsprite-acme",
      connectedAt: new Date(),
      snsTopicArn: TOPIC,
    });
    sns.on(ConfirmSubscriptionCommand).resolves({ SubscriptionArn: SUB });
    const res = await post(confirmation());
    expect(res.status).toBe(200);
    expect(
      sns.commandCalls(ConfirmSubscriptionCommand)[0]!.args[0].input,
    ).toEqual({
      TopicArn: TOPIC,
      Token: "t",
      AuthenticateOnUnsubscribe: "true",
    });
    expect(fetchCalls).toHaveLength(0);
    expect((await conn())?.snsSubscriptionArn).toBe(SUB);
  });

  it("falls back to SubscribeURL when the SDK confirm is refused", async () => {
    const { updateTeamAws } = await teamAwsSvc();
    await updateTeamAws(TEAM, { snsSubscriptionArn: null });
    sns
      .on(ConfirmSubscriptionCommand)
      .rejects(
        Object.assign(
          new Error("not authorized to perform: SNS:ConfirmSubscription"),
          { name: "AuthorizationError" },
        ),
      );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await post(confirmation({ MessageId: "m1a" }));
      expect(res.status).toBe(200);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/falling back/),
        expect.stringMatching(/ConfirmSubscription/),
      );
    } finally {
      warn.mockRestore();
    }
    expect(sns.commandCalls(ConfirmSubscriptionCommand)).toHaveLength(1);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain("ConfirmSubscription");
    expect(fetchCalls[0]!.init?.redirect).toBe("error");
    expect((await conn())?.snsSubscriptionArn).toBe(SUB);
  });

  it("does not overwrite the stored ARN when SNS returns none", async () => {
    sns.on(ConfirmSubscriptionCommand).resolves({});
    const res = await post(confirmation({ MessageId: "m1b" }));
    expect(res.status).toBe(200);
    expect((await conn())?.snsSubscriptionArn).toBe(SUB);
  });

  it("clears the ARN on UnsubscribeConfirmation", async () => {
    const res = await post({
      Type: "UnsubscribeConfirmation",
      TopicArn: TOPIC,
      MessageId: "m4",
    });
    expect(res.status).toBe(200);
    expect((await conn())?.snsSubscriptionArn).toBeNull();
  });

  /**
   * The topic ARN and the credentials now live on the same row, so "topic
   * known but no credentials" is unreachable — a team with no row is refused
   * by the topic check above. What remains worth pinning is that the
   * fallback fetch is time-limited and redirect-free.
   */
  it("time-limits the SubscribeURL fallback when the stored key is dead", async () => {
    const { updateTeamAws } = await teamAwsSvc();
    await updateTeamAws(TEAM, { accessKey: "AKIADEAD", secret: "dead" });
    sns.on(ConfirmSubscriptionCommand).rejects(
      Object.assign(new Error("The security token is invalid"), {
        name: "InvalidClientTokenId",
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let res;
    try {
      res = await post(confirmation({ MessageId: "m5" }));
    } finally {
      warn.mockRestore();
    }
    expect(res.status).toBe(200);
    expect(sns.commandCalls(ConfirmSubscriptionCommand)).toHaveLength(1);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain("ConfirmSubscription");
    expect(fetchCalls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect((await conn())?.snsSubscriptionArn).toBe(SUB);
  });

  it("keeps the stored ARN when the fallback response has no SubscriptionArn", async () => {
    fetchBody = "<ConfirmSubscriptionResponse/>";
    const res = await post(confirmation({ MessageId: "m6" }));
    expect(res.status).toBe(200);
    expect((await conn())?.snsSubscriptionArn).toBe(SUB);
  });

  it("rejects a look-alike SubscribeURL host without fetching", async () => {
    const res = await post(
      confirmation({
        SubscribeURL: "https://sns.us-east-1.amazonaws.com.evil.com/?x",
        MessageId: "m7",
      }),
    );
    expect(res.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });

  it("ignores confirmations for a foreign topic", async () => {
    const res = await post(
      confirmation({
        TopicArn: "arn:aws:sns:us-east-1:999:other",
        MessageId: "m2",
      }),
    );
    expect(res.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
    expect(sns.calls()).toHaveLength(0);
  });

  it("rejects oversized bodies with 413", async () => {
    const { POST } = await route();
    const big = "x".repeat(524_289);
    const declared = await POST(
      new Request(`https://mail.acme.com/api/webhooks/ses/${TEAM}`, {
        method: "POST",
        headers: { "content-length": String(big.length) },
        body: "{}",
      }),
      { params: Promise.resolve({ teamId: TEAM }) },
    );
    expect(declared.status).toBe(413);
    const actual = await POST(
      new Request(`https://mail.acme.com/api/webhooks/ses/${TEAM}`, {
        method: "POST",
        body: big,
      }),
      { params: Promise.resolve({ teamId: TEAM }) },
    );
    expect(actual.status).toBe(413);
  });

  it("acknowledges notifications it cannot ingest", async () => {
    const res = await post({
      Type: "Notification",
      TopicArn: TOPIC,
      Message: JSON.stringify({ eventType: "Send" }),
      MessageId: "m3",
      Timestamp: "2026-08-25T00:00:00Z",
    });
    expect(res.status).toBe(200);
  });
});

/**
 * The path names the tenant and the topic ARN proves it. Either alone is not
 * enough: a path is guessable, and a topic ARN says nothing about which
 * tenant a message is for.
 */
describe("team scoping", () => {
  it("rejects a topic belonging to another team", async () => {
    const { updateTeamAws } = await teamAwsSvc();
    await updateTeamAws(OTHER, {
      region: "us-east-1",
      accessKey: "AKIAEXAMPLEEXAMPLE",
      secret: "s3cr3ts3cr3ts3cr3ts3cr3t",
      configSet: "sendsprite-beta",
      connectedAt: new Date(),
      snsTopicArn: "arn:aws:sns:us-east-1:2:sendsprite-events-beta",
    });
    // TEAM's topic posted at OTHER's path.
    const res = await post(confirmation({ MessageId: "x1" }), OTHER);
    expect(res.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
    expect(sns.calls()).toHaveLength(0);
  });

  it("rejects a team with no connection at all", async () => {
    const res = await post(confirmation({ MessageId: "x2" }), "org_nope");
    expect(res.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });

  it("writes the subscription ARN only on the team named in the path", async () => {
    const { updateTeamAws } = await teamAwsSvc();
    await updateTeamAws(OTHER, { snsSubscriptionArn: null });
    await updateTeamAws(TEAM, { snsSubscriptionArn: null });
    sns.on(ConfirmSubscriptionCommand).resolves({ SubscriptionArn: SUB });
    expect((await post(confirmation({ MessageId: "x3" }))).status).toBe(200);
    expect((await conn(TEAM))?.snsSubscriptionArn).toBe(SUB);
    expect((await conn(OTHER))?.snsSubscriptionArn).toBeNull();
  });
});
