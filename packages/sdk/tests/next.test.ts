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
