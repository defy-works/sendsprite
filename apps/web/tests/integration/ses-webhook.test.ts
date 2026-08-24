import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startPg } from "./_pg";

vi.mock("@/lib/sns-message", () => ({
  verifySnsMessage: async (raw: unknown) => raw,
}));

let pg: Awaited<ReturnType<typeof startPg>>;
const fetchCalls: string[] = [];
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
  vi.stubGlobal("fetch", async (url: string) => {
    fetchCalls.push(String(url));
    return new Response(
      "<ConfirmSubscriptionResponse><ConfirmSubscriptionResult><SubscriptionArn>arn:aws:sns:us-east-1:1:sendsprite-events:sub-1</SubscriptionArn></ConfirmSubscriptionResult></ConfirmSubscriptionResponse>",
      { status: 200 },
    );
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pg.stop();
});

const post = async (body: unknown, type: string) => {
  const { POST } = await import("@/app/api/webhooks/ses/route");
  return POST(
    new Request("https://mail.acme.com/api/webhooks/ses", {
      method: "POST",
      headers: { "x-amz-sns-message-type": type, "content-type": "text/plain" },
      body: JSON.stringify(body),
    }),
  );
};

describe("POST /api/webhooks/ses", () => {
  it("confirms a subscription by fetching SubscribeURL and stores the arn", async () => {
    const { updateInstanceSettings, getInstanceSettings } =
      await import("@/services/instance-settings");
    await updateInstanceSettings({
      snsTopicArn: "arn:aws:sns:us-east-1:1:sendsprite-events",
    });
    const res = await post(
      {
        Type: "SubscriptionConfirmation",
        TopicArn: "arn:aws:sns:us-east-1:1:sendsprite-events",
        Token: "t",
        SubscribeURL:
          "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t",
        MessageId: "m1",
      },
      "SubscriptionConfirmation",
    );
    expect(res.status).toBe(200);
    expect(fetchCalls[0]).toContain("ConfirmSubscription");
    expect((await getInstanceSettings()).snsSubscriptionArn).toBe(
      "arn:aws:sns:us-east-1:1:sendsprite-events:sub-1",
    );
  });
  it("ignores confirmations for a foreign topic", async () => {
    const res = await post(
      {
        Type: "SubscriptionConfirmation",
        TopicArn: "arn:aws:sns:us-east-1:999:other",
        Token: "t",
        SubscribeURL: "https://sns.us-east-1.amazonaws.com/?x",
        MessageId: "m2",
      },
      "SubscriptionConfirmation",
    );
    expect(res.status).toBe(403);
    expect(fetchCalls).toHaveLength(1);
  });
  it("acknowledges notifications (processing lands in Phase 3)", async () => {
    const res = await post(
      {
        Type: "Notification",
        TopicArn: "arn:aws:sns:us-east-1:1:sendsprite-events",
        Message: JSON.stringify({ eventType: "Send" }),
        MessageId: "m3",
        Timestamp: "2026-08-25T00:00:00Z",
      },
      "Notification",
    );
    expect(res.status).toBe(200);
  });
});
