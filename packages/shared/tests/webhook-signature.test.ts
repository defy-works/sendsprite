import { createHmac } from "node:crypto";
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

  it("refuses an empty secret instead of verifying against the empty key", () => {
    // `createHmac("sha256", "")` is legal, so `process.env.SECRET ?? ""` would
    // otherwise accept anything an attacker signed with the empty key.
    // Built by hand: `signWebhook` now refuses an empty secret (see below),
    // so this is what an attacker with no secret would have to send.
    const forged = `t=${T},v1=${createHmac("sha256", "").update(`${T}.${BODY}`).digest("hex")}`;
    expect(verifyWebhookSignature(BODY, forged, "", at(T))).toBe(false);
    expect(verifyWebhookSignature(BODY, forged, SECRET, at(T))).toBe(false);
    const real = signWebhook(BODY, SECRET, T);
    expect(verifyWebhookSignature(BODY, real, "", at(T))).toBe(false);
    // And the signer refuses too, so an empty secret can never leave here as a
    // well-formed header that every receiver silently rejects.
    expect(() => signWebhook(BODY, "", T)).toThrow(/must not be empty/);
  });

  it("refuses a non-string header (a repeated header arrives as an array)", () => {
    const header = signWebhook(BODY, SECRET, T);
    // `["t=1700000000", "v1=<hex>"]` stringifies into a well-formed header.
    const split = [`t=${T}`, header.slice(`t=${T},`.length)];
    expect(String(split)).toBe(header); // the trap this guards against
    for (const value of [
      split,
      null,
      undefined,
      42,
      { toString: () => header },
    ])
      expect(
        verifyWebhookSignature(BODY, value as unknown as string, SECRET, at(T)),
      ).toBe(false);
  });

  it("accepts exactly one spelling of the timestamp", () => {
    const digest = signWebhook(BODY, SECRET, T).slice("t=1700000000,".length);
    // A replay cache keyed on the raw header would see these as new headers.
    for (const t of [`0${T}`, `00${T}`, `${T}000000000000`, "+1700000000"]) {
      expect(
        verifyWebhookSignature(BODY, `t=${t},${digest}`, SECRET, at(T)),
        t,
      ).toBe(false);
    }
    expect(
      verifyWebhookSignature(BODY, `t=${T},${digest}`, SECRET, at(T)),
    ).toBe(true);
    // `t=0` is still a legal spelling, just far outside the tolerance.
    const epoch = signWebhook(BODY, SECRET, 0);
    expect(verifyWebhookSignature(BODY, epoch, SECRET, { now: 0 })).toBe(true);
  });

  it("bounds how many digests one header may carry", () => {
    const mine = signWebhook(BODY, SECRET, T).slice("t=1700000000,".length);
    const filler = `v1=${"0".repeat(64)}`;
    const eight = [...Array(7).fill(filler), mine].join(",");
    expect(verifyWebhookSignature(BODY, `t=${T},${eight}`, SECRET, at(T))).toBe(
      true,
    );
    const nine = [...Array(8).fill(filler), mine].join(",");
    expect(verifyWebhookSignature(BODY, `t=${T},${nine}`, SECRET, at(T))).toBe(
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
      ["trailing newline", `t=${T},v1=${digest}` + "\n"],
      ["embedded newline", `t=${T}\nv1=${digest}`],
      ["empty", ""],
    ];
    for (const [name, header] of cases) {
      expect(verifyWebhookSignature(BODY, header, SECRET, at(T)), name).toBe(
        false,
      );
    }
  });
});
