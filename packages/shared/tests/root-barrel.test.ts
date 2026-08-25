import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as root from "../src/index";
import * as node from "../src/node";

describe("root barrel", () => {
  it("does not reference node:crypto anywhere in the root import graph", () => {
    // The root entry is inlined into the browser-safe `sendsprite` bundle.
    const files = [
      "src/index.ts",
      "src/ids.ts",
      "src/roles.ts",
      "src/api/errors.ts",
      "src/api/emails.ts",
      "src/api/webhooks.ts",
      "src/api/domains.ts",
      "src/api/api-keys.ts",
      "src/api/webhook-objects.ts",
      "src/api/suppressions.ts",
      "src/api/stats.ts",
      "src/api/me.ts",
      "src/api/stream.ts",
    ];
    for (const f of files) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/from "node:/);
    }
    expect("signWebhook" in root).toBe(false);
  });

  it("exposes the signing helpers from the node entry", () => {
    expect(typeof node.signWebhook).toBe("function");
    expect(typeof node.verifyWebhookSignature).toBe("function");
    expect(node.SIGNATURE_HEADER).toBe("sendsprite-signature");
  });
});
