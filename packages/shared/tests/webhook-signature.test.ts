import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhookSignature } from "../src/node";

const BODY = JSON.stringify({ id: "evt_1", type: "email.delivered" });
const SECRET = "whsec_test";
const T = 1_700_000_000;
const at = (now: number) => ({ now });

describe("webhook signature", () => {
  it("round-trips and rejects tampering / stale timestamps", () => {
    const header = signWebhook(BODY, SECRET, T);
    expect(header).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
    expect(verifyWebhookSignature(BODY, header, SECRET, at(T + 100))).toBe(
      true,
    );
    expect(
      verifyWebhookSignature(`${BODY} `, header, SECRET, at(T + 100)),
    ).toBe(false);
    expect(verifyWebhookSignature(BODY, header, SECRET, at(T + 600))).toBe(
      false,
    ); // > 300 s
    expect(verifyWebhookSignature(BODY, header, "whsec_other", at(T))).toBe(
      false,
    );
    expect(verifyWebhookSignature(BODY, "garbage", SECRET)).toBe(false);
  });

  it("rejects a clock that runs far ahead as well as far behind", () => {
    const header = signWebhook(BODY, SECRET, T);
    expect(verifyWebhookSignature(BODY, header, SECRET, at(T - 600))).toBe(
      false,
    );
    expect(verifyWebhookSignature(BODY, header, SECRET, at(T - 299))).toBe(
      true,
    );
  });

  it("accepts any of several v1 digests so a secret can be rotated", () => {
    // What a sender signing with two live keys would emit. Receivers pinned in
    // users' deployed apps must accept it, whichever key they hold.
    const mine = signWebhook(BODY, SECRET, T).slice("t=1700000000,".length);
    const theirs = signWebhook(BODY, "whsec_next", T).slice(
      "t=1700000000,".length,
    );
    const header = `t=${T},${theirs},${mine}`;
    expect(verifyWebhookSignature(BODY, header, SECRET, at(T))).toBe(true);
    expect(verifyWebhookSignature(BODY, header, "whsec_next", at(T))).toBe(
      true,
    );
    expect(verifyWebhookSignature(BODY, header, "whsec_third", at(T))).toBe(
      false,
    );
    // The timestamp still binds every digest.
    expect(verifyWebhookSignature(BODY, header, SECRET, at(T + 600))).toBe(
      false,
    );
  });

  it("rejects malformed headers rather than ignoring what it cannot parse", () => {
    const good = signWebhook(BODY, SECRET, T);
    const digest = good.slice("t=1700000000,v1=".length);
    const cases: [string, string][] = [
      ["no timestamp", `v1=${digest}`],
      ["non-numeric timestamp", `t=abc,v1=${digest}`],
      ["uppercase hex", `t=${T},v1=${digest.toUpperCase()}`],
      ["short digest", `t=${T},v1=${digest.slice(0, 63)}`],
      ["unknown extra field", `t=${T},v1=${digest},foo=bar`],
      ["unknown scheme version", `t=${T},v2=${digest}`],
      ["no digest at all", `t=${T}`],
      ["trailing comma", `t=${T},v1=${digest},`],
      ["leading whitespace", ` t=${T},v1=${digest}`],
      ["empty", ""],
    ];
    for (const [name, header] of cases) {
      expect(verifyWebhookSignature(BODY, header, SECRET, at(T)), name).toBe(
        false,
      );
    }
  });
});
