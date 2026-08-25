import { describe, expect, it } from "vitest";
import { ERROR_CODES, HTTP_STATUS } from "../src";
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
  it("rejects reserved headers, keeps List-Unsubscribe", () => {
    for (const k of [
      "To",
      "Return-Path",
      "Sender",
      "DKIM-Signature",
      "Received",
      "Content-Transfer-Encoding",
      "Authentication-Results",
    ])
      expect(() =>
        SendEmailInput.parse({ ...base, headers: { [k]: "x" } }),
      ).toThrow(/reserved/i);
    expect(
      SendEmailInput.parse({
        ...base,
        headers: { "List-Unsubscribe": "<mailto:u@b.com>" },
      }).headers,
    ).toEqual({ "List-Unsubscribe": "<mailto:u@b.com>" });
  });
  it("rejects header injection (CR/LF) and bad header names", () => {
    const bad = (patch: Record<string, unknown>) =>
      expect(() => SendEmailInput.parse({ ...base, ...patch })).toThrow();
    bad({ subject: "Hi\r\nBcc: x@y.com" });
    bad({ from: "A\nB <a@b.com>" });
    bad({ to: ["A\rB <a@b.com>"] }); // interior CR (edges are trimmed)
    bad({ headers: { "X-Foo": "a\nb" } });
    bad({ headers: { "X Foo": "a" } });
    bad({ headers: { "X-Foo:": "a" } });
    bad({ attachments: [{ filename: "a\nb.txt", content: "aGk=" }] });
    bad({ attachments: [{ filename: "../a.txt", content: "aGk=" }] });
    bad({ attachments: [{ filename: "c:\\a.txt", content: "aGk=" }] });
    bad({
      attachments: [
        { filename: "a.txt", content: "aGk=", contentType: "x\ny" },
      ],
    });
    expect(
      SendEmailInput.parse({ ...base, headers: { "X-Custom-1": "ok" } })
        .headers,
    ).toEqual({ "X-Custom-1": "ok" });
  });
  it("validates attachment content as base64 (whitespace tolerated)", () => {
    expect(() =>
      SendEmailInput.parse({
        ...base,
        attachments: [{ filename: "a.txt", content: "not base64!" }],
      }),
    ).toThrow(/base64/);
    expect(
      SendEmailInput.parse({
        ...base,
        attachments: [{ filename: "a.txt", content: "aGVs\nbG8=" }],
      }).attachments[0]!.content,
    ).toBe("aGVsbG8=");
  });
  it("validates tag keys and count", () => {
    expect(() =>
      SendEmailInput.parse({ ...base, tags: { "bad key": "v" } }),
    ).toThrow(/tag key/);
    expect(() =>
      SendEmailInput.parse({ ...base, tags: { "": "v" } }),
    ).toThrow();
    expect(() =>
      SendEmailInput.parse({
        ...base,
        tags: Object.fromEntries(
          Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]),
        ),
      }),
    ).toThrow(/20 tags/);
    expect(
      SendEmailInput.parse({ ...base, tags: { "camp-1_a": "v" } }).tags,
    ).toEqual({ "camp-1_a": "v" });
  });
});

describe("error codes", () => {
  it("maps every code to an HTTP status; conflict codes are 409", () => {
    for (const c of ERROR_CODES) expect(HTTP_STATUS[c]).toBeGreaterThan(399);
    expect(HTTP_STATUS.conflict).toBe(409);
    expect(HTTP_STATUS.idempotency_conflict).toBe(409);
    expect(ERROR_CODES).toContain("conflict");
  });
});
