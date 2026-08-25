import { defineConfig } from "tsup";

// The `react`, `next` and `cli` entries are added by later tasks.
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node20",
    noExternal: ["@sendsprite/shared"],
    external: ["react", "@react-email/render", "@react-email/components"],
  },
]);
