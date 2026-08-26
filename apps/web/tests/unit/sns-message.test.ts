import { describe, expect, it } from "vitest";
import { verifySnsMessage } from "@/lib/sns-message";

describe("verifySnsMessage", () => {
  it("rejects a message whose SigningCertURL is not on amazonaws.com", async () => {
    await expect(
      verifySnsMessage({
        Type: "Notification",
        MessageId: "1",
        TopicArn: "arn",
        Message: "{}",
        Timestamp: "2026-01-01T00:00:00Z",
        SignatureVersion: "1",
        Signature: "x",
        SigningCertURL: "https://evil.com/cert.pem",
      }),
    ).rejects.toThrow(/invalid domain/);
  });
  it("rejects a message with no signature fields", async () => {
    await expect(verifySnsMessage({ Type: "Notification" })).rejects.toThrow();
  });
});
