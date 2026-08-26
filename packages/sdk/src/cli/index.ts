/**
 * `npx sendsprite`. Everything the CLI touches from the outside world —
 * the config directory, the API client, stdout, stderr and the environment —
 * arrives as `CliDeps`, so `tests/cli.test.ts` drives the real commander
 * program without spawning a process. `bin.ts` is the entry that wires the
 * real ones up and is the only module that reads `process`.
 */
import { Command } from "commander";
import { SDK_VERSION } from "../client";
import { SendspriteError } from "../errors";
import type { Sendsprite } from "../index";
import { registerDomains } from "./commands/domains";
import { registerEmails } from "./commands/emails";
import { registerLogin } from "./commands/login";
import { registerTemplates } from "./commands/templates";
import { registerWhoami } from "./commands/whoami";
import { loadConfig, normalizeInstanceUrl, type CliConfig } from "./config";

export interface CliDeps {
  /** Directory holding `config.json`; see `defaultConfigDir()`. */
  configDir: string;
  createClient: (config: CliConfig) => Sendsprite;
  /** Writes one line of output (the newline is added by the sink). */
  write: (line: string) => void;
  /** Diagnostics; goes to stderr so `--json` output stays machine-readable. */
  writeError?: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /**
   * Asks the operator for a missing `login` value. Only supplied on a TTY —
   * without it a missing flag is an error, which is what CI wants. `mask`
   * asks for the answer not to be echoed.
   */
  prompt?: (question: string, opts?: { mask?: boolean }) => Promise<string>;
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
  writeError: (line: string) => void;
  /** Wraps an action so a failed call reports which credentials it used. */
  run: <A extends unknown[]>(
    action: (...args: A) => Promise<void>,
  ) => (...args: A) => Promise<void>;
}

/** The command registry. A new command is one entry here and one file. */
const COMMANDS: readonly ((ctx: CommandContext) => void)[] = [
  registerLogin,
  registerWhoami,
  registerDomains,
  registerEmails,
  registerTemplates,
];

/** Where the credentials in play came from, for error messages. */
type CredentialSource = "the environment" | "the config file";

interface Credentials {
  config: CliConfig;
  source: CredentialSource;
}

/** An env var that is unset, empty or blank is not set at all. */
const fromEnv = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * The URL and the key always come from the *same* place.
 *
 * Resolving them field by field means `SENDSPRITE_URL=https://evil.test` on a
 * logged-in machine sends the saved `ss_live_` key — a long-lived credential
 * the operator never re-typed — to a host of the attacker's choosing. So a
 * half-set environment is an error naming the missing variable, never a
 * silent fallback to the file for the other half.
 */
export function resolveCredentials(deps: CliDeps): Credentials {
  const url = fromEnv(deps.env.SENDSPRITE_URL);
  const apiKey = fromEnv(deps.env.SENDSPRITE_API_KEY);
  if (url !== undefined || apiKey !== undefined) {
    if (url === undefined) {
      throw new Error(
        "SENDSPRITE_API_KEY is set but SENDSPRITE_URL is not. Set both, or unset SENDSPRITE_API_KEY to use the saved credentials — the two are never mixed.",
      );
    }
    if (apiKey === undefined) {
      throw new Error(
        "SENDSPRITE_URL is set but SENDSPRITE_API_KEY is not. Set both, or unset SENDSPRITE_URL to use the saved credentials — the two are never mixed.",
      );
    }
    return {
      config: { url: normalizeInstanceUrl(url, "SENDSPRITE_URL"), apiKey },
      source: "the environment",
    };
  }
  const file = loadConfig(deps.configDir);
  if (!file) {
    throw new Error(
      "Not logged in. Run `sendsprite login --url <instance> --api-key <key>`, or set both SENDSPRITE_URL and SENDSPRITE_API_KEY.",
    );
  }
  return { config: file, source: "the config file" };
}

/** Statuses where the operator's first question is "which credentials?". */
const CREDENTIAL_STATUSES = new Set([401, 403, 404]);

export function buildProgram(deps: CliDeps): Command {
  const program = new Command("sendsprite")
    .description("Sendsprite CLI")
    .version(SDK_VERSION)
    // Must precede every `.command()` below: subcommands copy the exit
    // callback from their parent when they are created.
    .exitOverride();

  let inUse: Credentials | null = null;
  const client: ClientFactory = () => {
    inUse = resolveCredentials(deps);
    return deps.createClient(inUse.config);
  };

  /**
   * With the environment winning over the file, a stale exported
   * `SENDSPRITE_API_KEY` silently shadows a fresh `login` — so say which
   * instance was called and where the credentials came from. Never the key.
   */
  const run =
    <A extends unknown[]>(action: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      try {
        await action(...args);
      } catch (cause) {
        if (
          inUse === null ||
          !(cause instanceof SendspriteError) ||
          cause.status === null ||
          !CREDENTIAL_STATUSES.has(cause.status)
        ) {
          throw cause;
        }
        throw new Error(
          `${cause.message}\n  instance: ${inUse.config.url} (credentials from ${inUse.source})`,
          { cause },
        );
      }
    };

  const ctx: CommandContext = {
    program,
    deps,
    client,
    write: deps.write,
    writeError: deps.writeError ?? deps.write,
    run,
  };
  for (const register of COMMANDS) register(ctx);
  return program;
}
