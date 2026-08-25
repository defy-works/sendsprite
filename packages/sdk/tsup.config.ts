import { defineConfig } from "tsup";

// The `cli` entry is added by a later task.
const external = [
  "react",
  "react/jsx-runtime",
  "@react-email/render",
  "@react-email/components",
];

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node20",
    noExternal: ["@sendsprite/shared"],
    external,
  },
  {
    entry: { react: "src/react.tsx" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    target: "node20",
    external,
  },
  {
    // `sendsprite/next` inlines the two zod-free shared leaves it imports —
    // the regex covers their subpaths — so the published package needs
    // neither `@sendsprite/shared` nor `zod` (`tests/dist.test.ts` pins that).
    // `node:crypto` stays a runtime built-in, which is why this entry never
    // reaches the edge runtime.
    entry: { next: "src/next.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    target: "node20",
    noExternal: [/^@sendsprite\/shared(\/.*)?$/],
    // tsup 8 rewrites `node:crypto` to `crypto` by default (for Node < 14);
    // keep the prefix so bundlers can tell a built-in from a package.
    removeNodeProtocol: false,
    external,
  },
]);
