import js from "@eslint/js";
import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/drizzle/**",
      // Playwright's own output: gitignored, but a local e2e run before `lint`
      // would otherwise lint its bundled trace-viewer bundle (~3.9k errors).
      "**/playwright-report/**",
      "**/test-results/**",
      // Local agent tooling, untracked (see .gitignore). `.wolf/hooks/*.js`
      // is written by the OpenWolf CLI and `.opencode/plugin/**` by opencode,
      // and both are regenerated on update — fixing their `no-empty` and
      // `no-explicit-any` errors would be undone by the next install. Listed
      // here because eslint walks the working tree, not the index.
      ".wolf/**",
      ".opencode/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin },
    rules: { ...nextPlugin.configs.recommended.rules },
  },
  {
    // Plain-JS Node scripts. typescript-eslint switches `no-undef` off for
    // `.ts` (the compiler owns that check), but `.mjs` still gets it from
    // `js.configs.recommended`, so the Node globals must be declared here.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { Buffer: "readonly", process: "readonly", console: "readonly" },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
);
