import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Sendsprite } from "sendsprite";
import { createServer, MCP_VERSION } from "./server";

const DEFAULT_PORT = 3333;
const MCP_PATH = "/mcp";

const USAGE = `sendsprite-mcp ${MCP_VERSION}

  MCP server for a Sendsprite instance.

Usage
  sendsprite-mcp                 speak MCP over stdio (the default)
  sendsprite-mcp --http [port]   listen for POST ${MCP_PATH} (default port ${DEFAULT_PORT})

Environment (both required)
  SENDSPRITE_URL       your instance, e.g. https://mail.acme.com
  SENDSPRITE_API_KEY   an API key with the permissions the tools need
`;

/** Everything this process says about itself goes to stderr — see `main()`. */
const log = (message: string) => process.stderr.write(`${message}\n`);

interface Options {
  http: boolean;
  port: number;
  help: boolean;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = { http: false, port: DEFAULT_PORT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--http" || arg?.startsWith("--http=")) {
      options.http = true;
      // `--http 8080`, `--http=8080` or a bare `--http`. Port 0 asks the OS
      // for a free one, which is how the smoke test starts a real listener.
      const inline = arg.startsWith("--http=") ? arg.slice(7) : undefined;
      const next =
        inline ?? (/^\d+$/.test(argv[i + 1] ?? "") ? argv[++i] : undefined);
      if (next !== undefined) options.port = Number(next);
    } else if (arg) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * One `POST /mcp` = one server and one transport, both discarded when the
 * response ends (`sessionIdGenerator: undefined`). Stateless costs a cheap
 * object per call and buys a server that can sit behind any load balancer,
 * restart between requests, and never leak a session that a client abandoned.
 */
async function handleMcpPost(
  client: Sendsprite,
  req: Parameters<StreamableHTTPServerTransport["handleRequest"]>[0],
  res: Parameters<StreamableHTTPServerTransport["handleRequest"]>[1],
) {
  const server = createServer(client);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

function json(
  res: Parameters<StreamableHTTPServerTransport["handleRequest"]>[1],
  status: number,
  code: number,
  message: string,
) {
  res.writeHead(status, { "content-type": "application/json" }).end(
    // The MCP error envelope, so a misdirected client gets something it parses.
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
  );
}

async function serveHttp(client: Sendsprite, port: number) {
  const server = createHttpServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== MCP_PATH) {
      return json(res, 404, -32601, `Not found. The endpoint is ${MCP_PATH}.`);
    }
    if (req.method !== "POST") {
      // No GET: without sessions there is no stream to resume, and no DELETE
      // either since there is no session to end.
      res.setHeader("allow", "POST");
      return json(res, 405, -32601, "Method not allowed. Use POST.");
    }
    handleMcpPost(client, req, res).catch((e: unknown) => {
      log(`request failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) json(res, 500, -32603, "Internal server error.");
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve());
  });
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  log(`sendsprite-mcp listening on http://localhost:${bound}${MCP_PATH}`);
}

async function main() {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    log(USAGE);
    process.exit(2);
  }
  if (options.help) {
    log(USAGE);
    return;
  }

  let client: Sendsprite;
  try {
    // Reads SENDSPRITE_URL / SENDSPRITE_API_KEY and throws naming whichever
    // is missing, which is the only configuration this binary has.
    client = new Sendsprite();
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  if (options.http) return serveHttp(client, options.port);

  // stdio: stdout carries the JSON-RPC framing and nothing else. A stray
  // `console.log` from anywhere in the process would corrupt the stream, so
  // it is rerouted rather than trusted.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  const transport = new StdioServerTransport();
  await createServer(client).connect(transport);
}

main().catch((e: unknown) => {
  log(`sendsprite-mcp failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
