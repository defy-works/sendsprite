import { defineConfig } from "tsup";

// `sendsprite`, the MCP SDK and zod are real dependencies of the published
// package, so they stay imports. `@sendsprite/shared` is a *private* workspace
// package — its zod contracts are inlined instead (`tests/dist.test.ts` pins
// that no specifier survives).
const shared = [/^@sendsprite\/shared(\/.*)?$/];
const external = ["sendsprite", "@modelcontextprotocol/sdk", "zod"];

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node20",
    noExternal: shared,
    external,
  },
  {
    // `npx sendsprite-mcp`. Executable, no declarations, and `node:` prefixes
    // are kept so bundlers can tell a built-in from a package.
    entry: { bin: "src/bin.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    target: "node20",
    removeNodeProtocol: false,
    banner: { js: "#!/usr/bin/env node" },
    noExternal: shared,
    external,
  },
]);
