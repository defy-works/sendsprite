/**
 * Guards the published artefact: `@sendsprite/shared` is a private workspace
 * package, so its types must be inlined into the emitted declarations and
 * nothing from its runtime (`node:` builtins via ids/ulid) may leak into the
 * root entry. Runs `tsup` itself so the check is always against fresh output.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const dist = join(root, "dist");

/**
 * Runs the built bin with a config dir that cannot exist and no inherited
 * credentials, so the "not logged in" path is what a fresh machine sees.
 */
function run(args: string[]) {
  const result = spawnSync(process.execPath, [join(dist, "cli.js"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      SENDSPRITE_CONFIG_DIR: join(tmpdir(), "sendsprite-dist-test-absent"),
      SENDSPRITE_URL: undefined,
      SENDSPRITE_API_KEY: undefined,
    },
  });
  return result;
}

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
    // The bin is ESM-only and ships no declarations.
    expect(files).toContain("cli.js");
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

  it("ships the CLI as an executable ESM script with no bundled shared/zod", () => {
    const src = readFileSync(join(dist, "cli.js"), "utf8");
    expect(src.startsWith("#!/usr/bin/env node\n")).toBe(true);
    // `commander` is a real dependency, so it must stay an import.
    expect(src).toMatch(/["']commander["']/);
    expect(src).not.toMatch(/["']@sendsprite\/shared/);
    expect(src).not.toMatch(/["']zod["']/);
  });

  it("runs: `--help` exits 0, `whoami` exits 1 with the login hint", () => {
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: sendsprite");
    for (const command of ["login", "whoami", "domains", "emails"]) {
      expect(help.stdout).toContain(command);
    }

    const whoami = run(["whoami"]);
    expect(whoami.status).toBe(1);
    expect(`${whoami.stdout}${whoami.stderr}`).toMatch(
      /Not logged in.*sendsprite login/s,
    );
  });

  it("never names @react-email/* as a specifier in the root bundle", () => {
    // A literal `import("@react-email/render")` is resolved at build time by
    // Webpack/Turbopack, so a Next app that installs `sendsprite` without the
    // optional peer fails to build with `Module not found`.
    for (const f of ["index.js", "index.cjs"]) {
      const src = readFileSync(join(dist, f), "utf8");
      expect(src, f).not.toMatch(
        /(?:from|import|require)\s*\(?\s*["']@react-email\//,
      );
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
