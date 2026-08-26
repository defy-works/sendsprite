/**
 * `sendsprite/next`. The requests here are built the way the server really
 * builds them: `apps/web/src/services/webhooks.ts` `deliver()` POSTs the
 * exact `JSON.stringify(payload)` bytes with `content-type: application/json`,
 * `user-agent: Sendsprite-Webhooks/1`, `sendsprite-signature` (from
 * `signWebhook(body, secret, timestamp)`) and `sendsprite-event-id`.
 */
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  type WebhookPayload,
} from "@sendsprite/shared";
import { signWebhook } from "@sendsprite/shared/node";
import { describe, expect, it, vi } from "vitest";
import {
  createWebhookHandler,
  EVENT_ID_HEADER as SDK_EVENT_ID_HEADER,
  SIGNATURE_HEADER as SDK_SIGNATURE_HEADER,
  verifyWebhook,
  WebhookVerificationError,
} from "../src/next";

const secret = "whsec_test";
const payload: WebhookPayload = {
  id: "evt_1",
  type: "email.delivered",
  createdAt: "2026-01-01T00:00:00.000Z",
  data: { id: "em_1" },
};
const body = JSON.stringify(payload);

/** A request byte-for-byte like the one `deliver()` sends. */
const signed = (raw = body, ts = Math.floor(Date.now() / 1000)) =>
  new Request("https://app.example.com/api/webhooks/sendsprite", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Sendsprite-Webhooks/1",
      [SIGNATURE_HEADER]: signWebhook(raw, secret, ts),
      [EVENT_ID_HEADER]: payload.id,
    },
    body: raw,
  });

describe("sendsprite/next", () => {
  it("re-exports the delivery header names", () => {
    expect(SDK_SIGNATURE_HEADER).toBe(SIGNATURE_HEADER);
    expect(SDK_EVENT_ID_HEADER).toBe(EVENT_ID_HEADER);
  });
});

describe("verifyWebhook", () => {
  it("returns the typed payload for a valid signature", async () => {
    await expect(verifyWebhook(signed(), secret)).resolves.toEqual(payload);
  });

  it("rejects a missing signature header", async () => {
    const req = new Request("https://app.example.com", {
      method: "POST",
      body,
    });
    await expect(verifyWebhook(req, secret)).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });

  it("rejects a tampered body", async () => {
    const sig = signWebhook(body, secret);
    const tampered = new Request("https://app.example.com", {
      method: "POST",
      headers: { [SIGNATURE_HEADER]: sig },
      body: JSON.stringify({ ...payload, type: "email.bounced" }),
    });
    await expect(verifyWebhook(tampered, secret)).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });

  it("rejects a stale timestamp and the wrong secret", async () => {
    await expect(verifyWebhook(signed(body, 1_000), secret)).rejects.toThrow(
      WebhookVerificationError,
    );
    await expect(verifyWebhook(signed(), "whsec_other")).rejects.toThrow(
      WebhookVerificationError,
    );
  });

  it("rejects a body that is not JSON", async () => {
    await expect(verifyWebhook(signed("not json"), secret)).rejects.toThrow(
      WebhookVerificationError,
    );
  });

  it("rejects signed JSON that is not an event object", async () => {
    // Signed, so it really came from the sender — but `null`/`123`/a
    // type-less object must never reach the handler lookup.
    for (const raw of ["null", "123", '"str"', "[]", '{"id":"evt_1"}']) {
      await expect(verifyWebhook(signed(raw), secret), raw).rejects.toThrow(
        WebhookVerificationError,
      );
    }
  });

  it("accepts a header carrying several v1 digests (secret rotation)", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const mine = signWebhook(body, secret, ts).split(",")[1]!;
    const theirs = signWebhook(body, "whsec_next", ts).split(",")[1]!;
    const req = new Request("https://app.example.com", {
      method: "POST",
      headers: { [SIGNATURE_HEADER]: `t=${ts},${theirs},${mine}` },
      body,
    });
    await expect(verifyWebhook(req, secret)).resolves.toEqual(payload);
  });

  it("rejects malformed signature headers", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const digest = signWebhook(body, secret, ts).split("v1=")[1]!;
    for (const header of [
      `v1=${digest}`,
      `t=abc,v1=${digest}`,
      `t=${ts},v1=${digest.toUpperCase()}`,
      `t=${ts},v1=${digest},foo=bar`,
      `t=${ts}`,
    ]) {
      const req = new Request("https://app.example.com", {
        method: "POST",
        headers: { [SIGNATURE_HEADER]: header },
        body,
      });
      await expect(verifyWebhook(req, secret), header).rejects.toThrow(
        WebhookVerificationError,
      );
    }
  });

  it("treats an empty secret as a configuration error, not a bad signature", async () => {
    const error = await verifyWebhook(signed(), "").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WebhookVerificationError);
  });
});

describe("createWebhookHandler", () => {
  it("dispatches to the matching handler and returns 200", async () => {
    const delivered = vi.fn();
    const bounced = vi.fn();
    const POST = createWebhookHandler({
      secret,
      on: { "email.delivered": delivered, "email.bounced": bounced },
    });
    const res = await POST(signed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, id: "evt_1" });
    expect(delivered).toHaveBeenCalledWith(payload);
    expect(bounced).not.toHaveBeenCalled();
  });

  it("awaits an async handler before responding", async () => {
    const order: string[] = [];
    const POST = createWebhookHandler({
      secret,
      on: {
        "email.delivered": async () => {
          await Promise.resolve();
          order.push("handler");
        },
      },
    });
    await POST(signed());
    order.push("response");
    expect(order).toEqual(["handler", "response"]);
  });

  it("returns 401 on a bad signature and 200 for events without a handler", async () => {
    const POST = createWebhookHandler({ secret, on: {} });
    const bad = await POST(
      new Request("https://app.example.com", { method: "POST", body: "{}" }),
    );
    expect(bad.status).toBe(401);
    expect((await POST(signed())).status).toBe(200);
  });

  it("falls back to onUnhandled for events with no specific handler", async () => {
    const onUnhandled = vi.fn();
    const POST = createWebhookHandler({ secret, on: {}, onUnhandled });
    expect((await POST(signed())).status).toBe(200);
    expect(onUnhandled).toHaveBeenCalledWith(payload);
  });

  it("refuses to be constructed without a secret", () => {
    expect(() => createWebhookHandler({ secret: "", on: {} })).toThrow(
      /non-empty `secret`/,
    );
  });

  it("does not resolve handlers through Object.prototype", async () => {
    // A signed payload with `type: "toString"` used to find
    // `Object.prototype.toString`, call it, and answer 200 without ever
    // reaching `onUnhandled`.
    const onUnhandled = vi.fn();
    const POST = createWebhookHandler({ secret, on: {}, onUnhandled });
    for (const type of [
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
    ]) {
      const raw = JSON.stringify({ ...payload, type });
      const res = await POST(signed(raw));
      expect(res.status, type).toBe(200);
    }
    expect(onUnhandled).toHaveBeenCalledTimes(4);
    expect(onUnhandled.mock.calls[0]![0]).toMatchObject({ type: "toString" });
  });

  it("answers 500, not 401, when verification fails for a non-signature reason", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const POST = createWebhookHandler({ secret, on: {} });
      // A body that cannot be read is a runtime problem, not a forged request:
      // a 401 would tell Sendsprite to stop retrying.
      const broken = new Request("https://app.example.com", {
        method: "POST",
        headers: { [SIGNATURE_HEADER]: signWebhook(body, secret) },
        body,
      });
      vi.spyOn(broken, "text").mockRejectedValue(new Error("stream reset"));
      const res = await POST(broken);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: "webhook verification failed",
      });
    } finally {
      error.mockRestore();
    }
  });

  it("returns 500 when a handler throws so Sendsprite retries", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const POST = createWebhookHandler({
        secret,
        on: {
          "email.delivered": () => {
            throw new Error("db down");
          },
        },
      });
      const res = await POST(signed());
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "handler failed" });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
