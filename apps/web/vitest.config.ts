import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // `tsconfig.json` sets `jsx: "preserve"` because Next runs its own JSX
  // transform, and esbuild honours that — which leaves vitest holding a file
  // full of JSX it cannot parse the moment a test imports a page or a
  // component. Overridden here only; nothing about the Next build changes.
  //
  // This matters for one test in particular: the unsubscribe page must be
  // importable so a test can prove that rendering it (what every corporate
  // link scanner does) unsubscribes nobody.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 120_000,
          hookTimeout: 180_000,
          // Each file boots its own embedded Postgres; more than a few at
          // once starves the machine and flakes the slow loop tests.
          maxWorkers: 4,
        },
      },
    ],
  },
});
