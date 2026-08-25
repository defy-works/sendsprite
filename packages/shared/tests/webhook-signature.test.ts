import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhookSignature } from "../src/node";

describe("webhook signature", () => {
  it("round-trips and rejects tampering / stale timestamps", () => {
    const body = JSON.stringify({ id: "evt_1", type: "email.delivered" });
    const header = signWebhook(body, "whsec_test", 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
    expect(
      verifyWebhookSignature(body, header, "whsec_test", {
        now: 1_700_000_100,
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature(body + " ", header, "whsec_test", {
        now: 1_700_000_100,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature(body, header, "whsec_test", {
        now: 1_700_000_000 + 600,
      }),
    ).toBe(false); // > 300 s
    expect(verifyWebhookSignature(body, "garbage", "whsec_test")).toBe(false);
  });
});
