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

vi.mock("@/lib/sns-message", () => ({
  verifySnsMessage: async (raw: unknown) => raw,
}));

const TOPIC = "arn:aws:sns:us-east-1:1:sendsprite-events";
const SUB = `${TOPIC}:sub-1`;
const sns = mockClient(SNSClient);

let pg: Awaited<ReturnType<typeof startPg>>;
let fetchCalls: { url: string; init?: RequestInit }[] = [];
let fetchBody = "";
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
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

const settings = () => import("@/services/instance-settings");
const route = () => import("@/app/api/webhooks/ses/route");
const post = async (body: { Type: string } & Record<string, unknown>) => {
  const { POST } = await route();
  return POST(
    new Request("https://mail.acme.com/api/webhooks/ses", {
      method: "POST",
      headers: {
        "x-amz-sns-message-type": body.Type,
        "content-type": "text/plain",
      },
      body: JSON.stringify(body),
    }),
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
describe("POST /api/webhooks/ses", () => {
  it("confirms via the SDK with AuthenticateOnUnsubscribe when AWS is connected", async () => {
    const { updateInstanceSettings, getInstanceSettings } = await settings();
    await updateInstanceSettings({
      awsMode: "keys",
      awsRegion: "us-east-1",
      awsAccessKey: "AKIAEXAMPLEEXAMPLE",
      awsSecret: "s3cr3ts3cr3ts3cr3ts3cr3t",
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
    expect((await getInstanceSettings()).snsSubscriptionArn).toBe(SUB);
  });

  it("falls back to SubscribeURL when the SDK confirm is refused", async () => {
    const { updateInstanceSettings, getInstanceSettings } = await settings();
    await updateInstanceSettings({ snsSubscriptionArn: null });
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
    expect((await getInstanceSettings()).snsSubscriptionArn).toBe(SUB);
  });

  it("does not overwrite the stored ARN when SNS returns none", async () => {
    const { getInstanceSettings } = await settings();
    sns.on(ConfirmSubscriptionCommand).resolves({});
    const res = await post(confirmation({ MessageId: "m1b" }));
    expect(res.status).toBe(200);
    expect((await getInstanceSettings()).snsSubscriptionArn).toBe(SUB);
  });

  it("clears the ARN on UnsubscribeConfirmation", async () => {
    const { getInstanceSettings } = await settings();
    const res = await post({
      Type: "UnsubscribeConfirmation",
      TopicArn: TOPIC,
      MessageId: "m4",
    });
    expect(res.status).toBe(200);
    expect((await getInstanceSettings()).snsSubscriptionArn).toBeNull();
  });

  it("falls back to fetching SubscribeURL with a timeout when AWS is not connected", async () => {
    const { updateInstanceSettings, getInstanceSettings } = await settings();
    await updateInstanceSettings({
      awsMode: "none",
      awsAccessKey: null,
      awsSecret: null,
    });
    const res = await post(confirmation({ MessageId: "m5" }));
    expect(res.status).toBe(200);
    expect(sns.calls()).toHaveLength(0);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain("ConfirmSubscription");
    expect(fetchCalls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect((await getInstanceSettings()).snsSubscriptionArn).toBe(SUB);
  });

  it("keeps the stored ARN when the fallback response has no SubscriptionArn", async () => {
    const { getInstanceSettings } = await settings();
    fetchBody = "<ConfirmSubscriptionResponse/>";
    const res = await post(confirmation({ MessageId: "m6" }));
    expect(res.status).toBe(200);
    expect((await getInstanceSettings()).snsSubscriptionArn).toBe(SUB);
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
      new Request("https://mail.acme.com/api/webhooks/ses", {
        method: "POST",
        headers: { "content-length": String(big.length) },
        body: "{}",
      }),
    );
    expect(declared.status).toBe(413);
    const actual = await POST(
      new Request("https://mail.acme.com/api/webhooks/ses", {
        method: "POST",
        body: big,
      }),
    );
    expect(actual.status).toBe(413);
  });

  it("acknowledges notifications (processing lands in Phase 3)", async () => {
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
