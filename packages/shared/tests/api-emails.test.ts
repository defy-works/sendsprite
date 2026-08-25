import { describe, expect, it } from "vitest";
import { SendEmailInput } from "../src/api/emails";

const base = {
  from: "Acme <hello@mail.acme.com>",
  to: ["a@b.com"],
  subject: "Hi",
  html: "<p>x</p>",
};

describe("SendEmailInput", () => {
  it("accepts a minimal message and normalises recipients to arrays", () => {
    const r = SendEmailInput.parse({ ...base, to: "a@b.com" });
    expect(r.to).toEqual(["a@b.com"]);
    expect(r.cc).toEqual([]);
    expect(r.replyTo).toEqual([]);
  });
  it("requires html, text or template", () => {
    expect(() =>
      SendEmailInput.parse({ from: base.from, to: base.to, subject: "x" }),
    ).toThrow(/html|text|template/);
  });
  it("caps recipients at 50 total and rejects invalid emails", () => {
    expect(() =>
      SendEmailInput.parse({
        ...base,
        to: Array.from({ length: 51 }, (_, i) => `u${i}@b.com`),
      }),
    ).toThrow(/50/);
    expect(() =>
      SendEmailInput.parse({ ...base, to: ["not-an-email"] }),
    ).toThrow();
  });
  it("validates attachments (base64, ≤ 10 MB total) and scheduledAt (future ISO)", () => {
    expect(
      SendEmailInput.parse({
        ...base,
        attachments: [
          { filename: "a.txt", content: Buffer.from("hi").toString("base64") },
        ],
      }).attachments,
    ).toHaveLength(1);
    expect(() =>
      SendEmailInput.parse({ ...base, scheduledAt: "not-a-date" }),
    ).toThrow();
    expect(
      SendEmailInput.parse({ ...base, scheduledAt: "2030-01-01T00:00:00Z" })
        .scheduledAt,
    ).toBe("2030-01-01T00:00:00Z");
  });
  it("rejects reserved headers", () => {
    expect(() =>
      SendEmailInput.parse({ ...base, headers: { To: "x" } }),
    ).toThrow(/reserved/i);
  });
});
