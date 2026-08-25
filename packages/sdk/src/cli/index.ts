/**
 * `npx sendsprite`. Everything the CLI touches from the outside world —
 * the config directory, the API client, stdout and the environment — arrives
 * as `CliDeps`, so `tests/cli.test.ts` drives the real commander program
 * without spawning a process. `bin.ts` is the entry that wires the real ones
 * up and is the only module that reads `process`.
 */
import { Command } from "commander";
import { SDK_VERSION } from "../client";
import type { Sendsprite } from "../index";
import { registerDomains } from "./commands/domains";
import { registerEmails } from "./commands/emails";
import { registerLogin } from "./commands/login";
import { registerWhoami } from "./commands/whoami";
import { loadConfig, type CliConfig } from "./config";

export interface CliDeps {
  /** Directory holding `config.json`; see `defaultConfigDir()`. */
  configDir: string;
  createClient: (config: CliConfig) => Sendsprite;
  /** Writes one line of output (the newline is added by the sink). */
  write: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /**
   * Asks the operator for a missing `login` value. Only supplied on a TTY —
   * without it a missing flag is an error, which is what CI wants.
   */
  prompt?: (question: string) => Promise<string>;
}

/**
 * Resolves credentials and builds a client, or throws the "log in first"
 * error. Commands call it lazily so `--help` never needs credentials.
 */
export type ClientFactory = () => Sendsprite;

export interface CommandContext {
  program: Command;
  deps: CliDeps;
  client: ClientFactory;
  write: (line: string) => void;
}

/**
 * The command registry. Phase 5's `templates pull|push` slots in as one more
 * `registerTemplates` entry — no other file needs to change.
 */
const COMMANDS: readonly ((ctx: CommandContext) => void)[] = [
  registerLogin,
  registerWhoami,
  registerDomains,
  registerEmails,
];

export function buildProgram(deps: CliDeps): Command {
  const program = new Command("sendsprite")
    .description("Sendsprite CLI")
    .version(SDK_VERSION)
    // Must precede every `.command()` below: subcommands copy the exit
    // callback from their parent when they are created.
    .exitOverride();

  const client: ClientFactory = () => {
    // The environment wins over the file so CI can run without `login`.
    const file = loadConfig(deps.configDir);
    const url = deps.env.SENDSPRITE_URL ?? file?.url;
    const apiKey = deps.env.SENDSPRITE_API_KEY ?? file?.apiKey;
    if (!url || !apiKey) {
      throw new Error(
        "Not logged in. Run `sendsprite login --url <instance> --api-key <key>`, or set SENDSPRITE_URL and SENDSPRITE_API_KEY.",
      );
    }
    return deps.createClient({ url, apiKey });
  };

  const ctx: CommandContext = { program, deps, client, write: deps.write };
  for (const register of COMMANDS) register(ctx);
  return program;
}
