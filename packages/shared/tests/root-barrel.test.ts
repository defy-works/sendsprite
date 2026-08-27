import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as root from "../src/index";
import * as node from "../src/node";

const SRC = new URL("../src/", import.meta.url);
const IMPORT_RE = /from\s+"(\.{1,2}\/[^"]+)"/g;

/** Every file reachable from `entry` through relative import specifiers. */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (rel: string) => {
    const url = new URL(rel.endsWith(".ts") ? rel : `${rel}.ts`, SRC);
    const key = url.pathname.slice(SRC.pathname.length);
    if (seen.has(key)) return;
    seen.add(key);
    const src = readFileSync(url, "utf8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1]!;
      const dir = key.includes("/")
        ? key.slice(0, key.lastIndexOf("/") + 1)
        : "";
      walk(new URL(spec, `file:///${dir}`).pathname.slice(1));
    }
  };
  walk(entry);
  return seen;
}

describe("root barrel", () => {
  it("does not reference node: built-ins anywhere in the root import graph", () => {
    // The root entry is inlined into the browser-safe `sendsprite` bundle.
    const graph = importGraph("index.ts");
    expect(graph.size).toBeGreaterThan(10);
    for (const f of graph) {
      const src = readFileSync(new URL(f, SRC), "utf8");
      expect(src, f).not.toMatch(/from "node:/);
    }
    expect(graph.has("api/webhook-signature.ts")).toBe(false);
    expect(graph.has("api/unsubscribe-token.ts")).toBe(false);
    expect("signWebhook" in root).toBe(false);
    expect("signUnsubscribeToken" in root).toBe(false);
  });

  it("exposes the signing helpers from the node entry", () => {
    const graph = importGraph("node.ts");
    expect(graph.has("api/webhook-signature.ts")).toBe(true);
    expect(graph.has("api/unsubscribe-token.ts")).toBe(true);
    expect(typeof node.signWebhook).toBe("function");
    expect(typeof node.verifyWebhookSignature).toBe("function");
    expect(typeof node.signUnsubscribeToken).toBe("function");
    expect(typeof node.verifyUnsubscribeToken).toBe("function");
    expect(node.SIGNATURE_HEADER).toBe("sendsprite-signature");
  });
});
