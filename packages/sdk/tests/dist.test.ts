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

  it("emits ESM, CJS and declarations for every entry", () => {
    const files = readdirSync(dist);
    for (const entry of ["index", "react", "next"]) {
      for (const ext of ["js", "cjs", "d.ts", "d.cts"]) {
        expect(files).toContain(`${entry}.${ext}`);
      }
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

  it("keeps @types/react out of the root and next declarations", () => {
    // React is an optional peer: `import type { ReactElement } from "react"`
    // in these entries would make `@types/react` mandatory for every user.
    for (const f of ["index.d.ts", "index.d.cts", "next.d.ts", "next.d.cts"]) {
      const src = readFileSync(join(dist, f), "utf8");
      expect(src, f).not.toMatch(
        /(?:from|import|require)\s*\(?\s*["']react["']/,
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

  it("builds sendsprite/next on node:crypto alone", () => {
    // The signature check needs a real HMAC, but neither the private shared
    // package nor zod (which the shared barrel drags in) may ship with it.
    for (const f of ["next.js", "next.cjs"]) {
      const src = readFileSync(join(dist, f), "utf8");
      expect(src, f).toMatch(/["']node:crypto["']/);
      expect(src, f).not.toMatch(/["']@sendsprite\/shared/);
      expect(src, f).not.toMatch(/["']zod["']/);
    }
  });
});
