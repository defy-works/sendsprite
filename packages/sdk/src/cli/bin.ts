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

/**
 * Interactive prompts only make sense on a terminal; CI gets a clear error.
 *
 * A masked answer is not echoed at all (the `sudo` convention). Prompting for
 * a key that then sits in the scrollback — and in the terminal's own buffer —
 * would defeat the point of not passing it as a flag.
 */
const prompt = process.stdin.isTTY
  ? async (question: string, opts?: { mask?: boolean }): Promise<string> => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });
      try {
        if (!opts?.mask) return await rl.question(question);
        process.stdout.write(question);
        // `_writeToOutput` is readline's single echo path; replacing it is the
        // only way to suppress the echo without reimplementing the interface.
        (
          rl as unknown as { _writeToOutput: (s: string) => void }
        )._writeToOutput = () => {};
        const answer = await rl.question("");
        process.stdout.write("\n");
        return answer;
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
  writeError: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  prompt,
})
  .parseAsync(process.argv)
  .catch((cause: unknown) => {
    const code = commanderExitCode(cause);
    if (code !== null) {
      // `process.exit()` would discard whatever is still buffered for a piped
      // stdout; setting the code lets Node drain and exit on its own.
      process.exitCode = code;
      return;
    }
    process.stderr.write(`${message(cause)}\n`);
    process.exitCode = 1;
  });
