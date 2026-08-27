import { DEFAULT_BASE_URL } from "sendsprite";
import { MCP_VERSION } from "./server";

export const DEFAULT_PORT = 3333;
export const MCP_PATH = "/mcp";
/** Loopback: the process holds a live API key and authenticates nobody. */
export const DEFAULT_HOST = "127.0.0.1";

export const USAGE = `sendsprite-mcp ${MCP_VERSION}

  MCP server for a Sendsprite instance.

Usage
  sendsprite-mcp                 speak MCP over stdio (the default)
  sendsprite-mcp --http [port]   listen for POST ${MCP_PATH} (default port ${DEFAULT_PORT})

Environment
  SENDSPRITE_API_KEY   required — an API key with the permissions the tools need
  SENDSPRITE_URL       a self-hosted instance, e.g. https://mail.acme.com
                       (default ${DEFAULT_BASE_URL})
  SENDSPRITE_MCP_HOST  --http bind address (default ${DEFAULT_HOST}; anything
                       else exposes an unauthenticated endpoint holding your key)
`;

export interface Options {
  http: boolean;
  port: number;
  help: boolean;
}

/**
 * Parses the binary's three arguments. Lives apart from `bin.ts` so it can be
 * unit-tested without evaluating a module whose whole job is side effects.
 */
export function parseArgs(argv: string[]): Options {
  const options: Options = { http: false, port: DEFAULT_PORT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--http" || arg?.startsWith("--http=")) {
      options.http = true;
      // `--http 8080`, `--http=8080` or a bare `--http`. A spaced value is
      // only claimed when it looks like a port, so `--http --help` still works.
      const inline = arg.startsWith("--http=") ? arg.slice(7) : undefined;
      const value =
        inline ?? (/^\d+$/.test(argv[i + 1] ?? "") ? argv[++i] : undefined);
      if (value !== undefined) options.port = port(value);
    } else if (arg) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** 0 means "ask the OS for a free one", which the smoke tests rely on. */
function port(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`invalid port: ${value} (expected 0–65535)`);
  }
  return n;
}
