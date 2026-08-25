#!/usr/bin/env node
/**
 * The `sendsprite` bin (`npx sendsprite …`). The only module that touches
 * `process`: everything else takes its I/O through `CliDeps`.
 */
import { createInterface } from "node:readline/promises";
import { Sendsprite } from "../index";
import { defaultConfigDir } from "./config";
import { buildProgram } from "./index";
import { message } from "./output";

/** Interactive prompts only make sense on a terminal; CI gets a clear error. */
const prompt = process.stdin.isTTY
  ? async (question: string): Promise<string> => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    }
  : undefined;

/** Commander already printed help, `--version` or a usage error itself. */
function commanderExitCode(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null) return null;
  const { code, exitCode } = cause as { code?: unknown; exitCode?: unknown };
  if (typeof code !== "string" || !code.startsWith("commander.")) return null;
  return typeof exitCode === "number" ? exitCode : 1;
}

buildProgram({
  configDir: defaultConfigDir(),
  createClient: (config) =>
    new Sendsprite({ baseUrl: config.url, apiKey: config.apiKey }),
  write: (line) => process.stdout.write(`${line}\n`),
  env: process.env,
  prompt,
})
  .parseAsync(process.argv)
  .catch((cause: unknown) => {
    const code = commanderExitCode(cause);
    if (code !== null) process.exit(code);
    process.stderr.write(`${message(cause)}\n`);
    process.exit(1);
  });
