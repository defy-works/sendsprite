import { defineConfig } from "tsup";

// The `next` and `cli` entries are added by later tasks.
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
]);
