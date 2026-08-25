/**
 * The API key `setup.spec.ts` hands to `sdk.spec.ts`.
 *
 * Environment variables do not cross Playwright workers (each worker is its
 * own process, forked before any test runs), so the secret travels through a
 * file in the project output directory instead. Playwright clears that
 * directory once at the start of the run — before the `setup` project writes —
 * so the file is always this run's key, never a stale one.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestInfo } from "@playwright/test";

const file = (info: TestInfo) =>
  join(info.project.outputDir, "e2e-api-key.txt");

export function saveApiKey(info: TestInfo, secret: string): void {
  const path = file(info);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, secret, "utf8");
}

/**
 * @throws {Error} naming the producing spec — a missing file means the `setup`
 * project did not run (or failed), which is far from obvious at the read site.
 */
export function loadApiKey(info: TestInfo): string {
  const path = file(info);
  let secret: string;
  try {
    secret = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(
      `No API key at ${path}. setup.spec.ts writes it; run the whole suite (the \`setup\` project) rather than this file alone.`,
    );
  }
  if (!secret.startsWith("ss_live_")) {
    throw new Error(`API key at ${path} does not look like a key.`);
  }
  return secret;
}

/** The instance under test, as `playwright.config.ts` computed it. */
export function baseUrl(info: TestInfo): string {
  const url = info.project.use.baseURL;
  if (!url) throw new Error("playwright config has no baseURL");
  return url.replace(/\/+$/, "");
}
