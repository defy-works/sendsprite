import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `public/install.sh` and `public/docker-compose.yml` are byte copies of the
 * repo-root originals so every instance serves them (sendsprite.com is the one
 * the documented `curl -fsSL https://sendsprite.com/install.sh | sh` hits).
 * Run `bun run sync:scripts` from the repo root after editing either original.
 */
const web = process.cwd();
const root = join(web, "..", "..");
const FILES = ["install.sh", "docker-compose.yml"] as const;

describe("served scripts", () => {
  for (const f of FILES) {
    it(`public/${f} is in sync with the repo root copy`, () => {
      const served = readFileSync(join(web, "public", f), "utf8");
      const canonical = readFileSync(join(root, f), "utf8");
      expect(served, `out of date — run: bun run sync:scripts`).toBe(canonical);
    });
  }

  it("install.sh is LF-only so `curl | sh` works", () => {
    expect(readFileSync(join(web, "public", "install.sh"), "utf8")).not.toMatch(
      /\r/,
    );
  });
});
