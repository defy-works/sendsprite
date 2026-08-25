/**
 * Guards the published artefact: `@sendsprite/shared` is a private workspace
 * package, so its types must be inlined into the emitted declarations and
 * nothing from its runtime (`node:` builtins via ids/ulid) may leak into the
 * root entry. Runs `tsup` itself so the check is always against fresh output.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const dist = join(root, "dist");

describe("dist", () => {
  beforeAll(() => {
    execFileSync("bunx", ["tsup"], {
      cwd: root,
      stdio: "pipe",
      shell: process.platform === "win32",
    });
  }, 120_000);

  it("emits ESM, CJS and declarations for the root entry", () => {
    const files = readdirSync(dist);
    for (const f of ["index.js", "index.cjs", "index.d.ts", "index.d.cts"]) {
      expect(files).toContain(f);
    }
  });

  it("inlines @sendsprite/shared types into every .d.ts / .d.cts", () => {
    const decls = readdirSync(dist).filter((f) => /\.d\.c?ts$/.test(f));
    expect(decls.length).toBeGreaterThan(0);
    for (const f of decls) {
      // Only module specifiers count; doc comments may mention the package.
      expect(readFileSync(join(dist, f), "utf8"), f).not.toMatch(
        /["']@sendsprite\/shared|["']zod["']/,
      );
    }
  });

  it("keeps node: builtins and the shared runtime out of the root bundle", () => {
    for (const f of ["index.js", "index.cjs"]) {
      const src = readFileSync(join(dist, f), "utf8");
      expect(src, f).not.toMatch(/["']node:/);
      expect(src, f).not.toMatch(/["']@sendsprite\/shared/);
      expect(src, f).not.toContain("ulid");
    }
  });
});
