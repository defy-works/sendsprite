/**
 * Keeps the version constant each published package reports at runtime in sync
 * with its `package.json`. `sendsprite` sends `SDK_VERSION` in its user-agent
 * and `@sendsprite/mcp` announces `MCP_VERSION` in the MCP handshake, so a
 * release that bumps only the manifest would ship a lying build.
 *
 * `bun run version-packages` runs this right after `changeset version`, so the
 * rewritten constants land in the same "Version Packages" PR as the bumps.
 * Run it by hand (`bun run sync:version`) after editing a version by hand; it
 * is a no-op when everything already agrees.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** One row per published package: where its manifest is and which constant mirrors it. */
const targets = [
  {
    packageDir: "packages/sdk",
    file: "src/client.ts",
    constName: "SDK_VERSION",
  },
  {
    packageDir: "packages/mcp",
    file: "src/server.ts",
    constName: "MCP_VERSION",
  },
];

let changed = 0;
for (const { packageDir, file, constName } of targets) {
  const manifest = join(root, packageDir, "package.json");
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as {
    version: string;
  };
  const source = join(root, packageDir, file);
  const before = readFileSync(source, "utf8");
  // Matches `export const NAME = "x.y.z"` and leaves any trailing comment alone.
  const pattern = new RegExp(
    String.raw`(export const ${constName}\s*=\s*)("[^"]*"|'[^']*')`,
  );
  if (!pattern.test(before)) {
    throw new Error(
      `${packageDir}/${file}: no \`export const ${constName}\` to sync`,
    );
  }
  const after = before.replace(pattern, `$1"${version}"`);
  if (after === before) {
    console.log(`${packageDir}: ${constName} already ${version}`);
    continue;
  }
  writeFileSync(source, after);
  changed += 1;
  console.log(`${packageDir}: ${constName} -> ${version}`);
}

console.log(
  changed === 0
    ? "sync-version: nothing to do"
    : `sync-version: rewrote ${changed} file(s)`,
);
