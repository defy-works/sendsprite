// First, and before any dependency gets a chance to write to stdout.
import { protocolStdout } from "./stdout-guard";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Sendsprite } from "sendsprite";
import { DEFAULT_HOST, MCP_PATH, parseArgs, USAGE, type Options } from "./args";
import { createServer } from "./server";

/**
 * Largest request body accepted in `--http` mode. Without a cap the transport
 * buffers whatever is sent before parsing it, so one POST can exhaust memory.
 * A real MCP call is kilobytes; 20 MB leaves room for a base64 attachment on
 * `send_email` (the API's own limit is 10 MB of attachments).
 */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

/** Everything this process says about itself goes to stderr — see `stdout-guard`. */
const log = (message: string) => process.stderr.write(`${message}\n`);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function json(res: ServerResponse, status: number, code: number, text: string) {
  // The JSON-RPC error envelope, so a misdirected client gets something it parses.
  res.writeHead(status, { "content-type": "application/json" }).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message: text },
      id: null,
    }),
  );
}

const isLoopback = (host: string) =>
  host === "localhost" || host === "::1" || host.startsWith("127.");

class BodyTooLarge extends Error {}

/**
 * Reads the body ourselves, capped, instead of letting the transport call
 * `req.json()` on an unbounded stream. Counting as we read covers a chunked
 * body that never declared a `content-length`, and the socket is destroyed as
 * soon as the cap is passed rather than after the sender is done.
 */
function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Promise.reject(new BodyTooLarge());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.once("error", reject);
  });
}

/**
 * One `POST /mcp` = one server and one transport, both discarded when the
 * response ends (`sessionIdGenerator: undefined`). Stateless costs a cheap
 * object per call and buys a server that can sit behind any load balancer,
 * restart between requests, and never leak a session a client abandoned.
 */
async function handleMcpPost(
  client: Sendsprite,
  allowedHosts: string[] | undefined,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const body = await readBody(req);

  // Imported lazily: it pulls in @hono/node-server, which a stdio launch —
  // the common case — has no use for.
  const { StreamableHTTPServerTransport } =
    await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const server = createServer(client);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Deprecated in the SDK in favour of external middleware, but this binary
    // *is* the only middleware a loopback deployment has.
    ...(allowedHosts
      ? { enableDnsRebindingProtection: true, allowedHosts }
      : {}),
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  // Pre-parsed: the stream is already consumed, and this is the same path
  // the SDK documents for body-parser middleware.
  await transport.handleRequest(
    req,
    res,
    body === "" ? undefined : JSON.parse(body),
  );
}

async function serveHttp(client: Sendsprite, port: number) {
  const host = process.env.SENDSPRITE_MCP_HOST ?? DEFAULT_HOST;
  /** Filled in once the port is known; no request can arrive before then. */
  let allowedHosts: string[] | undefined;

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
    handleMcpPost(client, allowedHosts, req, res).catch((e: unknown) => {
      if (res.headersSent || res.writableEnded) return void res.end();
      if (e instanceof BodyTooLarge) {
        return json(
          res,
          413,
          -32600,
          `Request body exceeds ${MAX_BODY_BYTES} bytes.`,
        );
      }
      if (e instanceof SyntaxError) {
        return json(res, 400, -32700, "Parse error: body is not valid JSON.");
      }
      log(`request failed: ${message(e)}`);
      json(res, 500, -32603, "Internal server error.");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  const loopback = isLoopback(host);
  if (loopback) {
    // DNS rebinding: a page in the operator's browser resolving an attacker's
    // name to 127.0.0.1 and POSTing here. The Host header is how we tell that
    // apart from a genuine local client.
    allowedHosts = [
      `localhost:${bound}`,
      `127.0.0.1:${bound}`,
      `[::1]:${bound}`,
    ];
  }
  log(`sendsprite-mcp listening on http://${host}:${bound}${MCP_PATH}`);
  if (!loopback) {
    log(
      `warning: bound to ${host}, not loopback. This endpoint holds your API ` +
        `key and authenticates nobody — put your own authentication in front of it.`,
    );
  }

  const shutdown = () => {
    server.close(() => process.exit(0));
    // Do not let a hung connection hold the process open forever.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

async function main() {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (e) {
    log(message(e));
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
    // is missing, which is nearly the only configuration this binary has.
    client = new Sendsprite();
  } catch (e) {
    log(message(e));
    process.exit(1);
  }

  if (options.http) return serveHttp(client, options.port);

  // `protocolStdout` is the reserved fd-1 handle; the public
  // `process.stdout.write` now points at stderr (see `stdout-guard`).
  await createServer(client).connect(
    new StdioServerTransport(process.stdin, protocolStdout),
  );
}

main().catch((e: unknown) => {
  log(`sendsprite-mcp failed: ${message(e)}`);
  process.exit(1);
});
