/**
 * Guards the published artefact. `@sendsprite/shared` is a private workspace
 * package, so nothing may reference it by specifier; the bin must be an
 * executable script; and stdio mode must speak clean JSON-RPC, which is only
 * true if nothing else writes to stdout. Runs `tsup` itself so the checks are
 * always against fresh output.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const dist = join(root, "dist");
const bin = join(dist, "bin.js");

/**
 * A POST built by hand. `fetch` refuses to send a `content-length` that does
 * not match the body, and will not stream an oversized chunked body either —
 * both of which is exactly what the size cap has to survive. Resolves with
 * whatever the server managed to send back before the socket closed.
 */
function rawPost(
  port: number,
  options: {
    headers?: Record<string, string>;
    body?: string;
    /** Number of 1 MB chunks to stream (chunked encoding). */
    chunks?: number;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const headers = {
        host: `127.0.0.1:${port}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...options.headers,
      };
      const head = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("");
      socket.write(`POST /mcp HTTP/1.1\r\n${head}\r\n`);
      if (options.body) socket.write(options.body);
      const megabyte = "x".repeat(1024 * 1024);
      for (let i = 0; i < (options.chunks ?? 0); i++) {
        if (socket.destroyed || socket.writableEnded) break;
        socket.write(`${megabyte.length.toString(16)}\r\n${megabyte}\r\n`);
      }
    });
    let response = "";
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("data", (c: Buffer) => (response += c.toString()));
    socket.on("close", () => resolve(response));
    socket.on("error", () => resolve(response));
    socket.once("timeout", () => reject(new Error("rawPost timed out")));
  });
}

/** Credentials the client never gets to use: no tool is called here. */
const env = {
  ...process.env,
  SENDSPRITE_URL: "http://127.0.0.1:1",
  SENDSPRITE_API_KEY: "ss_test_key",
};

describe("dist", () => {
  beforeAll(() => {
    execFileSync("bunx", ["tsup"], {
      cwd: root,
      stdio: "pipe",
      shell: process.platform === "win32",
    });
  }, 120_000);

  it("emits the library entry with declarations, and an ESM bin", () => {
    const files = readdirSync(dist);
    for (const f of ["index.js", "index.d.ts", "bin.js"]) {
      expect(files).toContain(f);
    }
  });

  it("keeps @sendsprite/shared out of the build", () => {
    for (const f of readdirSync(dist).filter((f) => /\.(js|d\.ts)$/.test(f))) {
      // Only module specifiers count; doc comments may mention the package.
      expect(readFileSync(join(dist, f), "utf8"), f).not.toMatch(
        /["']@sendsprite\/shared/,
      );
    }
  });

  it("keeps the real dependencies external", () => {
    const src = readFileSync(join(dist, "index.js"), "utf8");
    expect(src).toMatch(/["']@modelcontextprotocol\/sdk\//);
    expect(src).toMatch(/["']zod["']/);
  });

  it("ships the bin as an executable script", () => {
    const src = readFileSync(bin, "utf8");
    expect(src.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(src).toMatch(/["']node:http["']/);
  });

  it("exits 1 with a usable message when the credentials are missing", () => {
    const result = spawnSync(process.execPath, [bin], {
      encoding: "utf8",
      env: {
        ...process.env,
        SENDSPRITE_URL: undefined,
        SENDSPRITE_API_KEY: undefined,
      },
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/SENDSPRITE_API_KEY/);
    // Even a failure must not put anything on stdout.
    expect(result.stdout).toBe("");
  });

  it("speaks MCP over stdio with nothing else on stdout", async () => {
    const client = new Client({ name: "dist-test", version: "0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin],
      env: env as Record<string, string>,
      stderr: "pipe",
    });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("send_email");
      expect(names).toHaveLength(6);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("survives a dependency writing junk to stdout", async () => {
    // `console.dir` and a raw `process.stdout.write` are the two escapes a
    // `console.log = console.error` patch does not close. If either reaches
    // fd 1 the JSON-RPC framing is corrupt and this handshake throws.
    const client = new Client({ name: "noisy-test", version: "0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin],
      env: {
        ...env,
        NODE_OPTIONS: `--require ${join(__dirname, "fixtures", "noisy-stdout.cjs")}`,
      } as Record<string, string>,
      stderr: "pipe",
    });
    await client.connect(transport);
    try {
      // Well after the fixture's deferred writes have fired.
      await new Promise((r) => setTimeout(r, 200));
      expect((await client.listTools()).tools).toHaveLength(6);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("--http serves POST /mcp and announces itself on stderr", async () => {
    const child = spawn(process.execPath, [bin, "--http", "0"], { env });
    try {
      const stdout: string[] = [];
      child.stdout.on("data", (c: Buffer) => stdout.push(c.toString()));
      const line = await new Promise<string>((resolve, reject) => {
        let buffer = "";
        child.stderr.on("data", (c: Buffer) => {
          buffer += c.toString();
          if (buffer.includes("\n")) resolve(buffer);
        });
        child.once("exit", (code) =>
          reject(new Error(`exited early with ${code}: ${buffer}`)),
        );
      });
      const port = /http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(line)?.[1];
      expect(port, line).toBeTruthy();

      const url = `http://127.0.0.1:${port}/mcp`;
      const initialize = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "dist-test", version: "0" },
          },
        }),
      });
      expect(initialize.ok).toBe(true);
      expect(await initialize.text()).toContain("sendsprite");
      // Stateless: no session to hand back.
      expect(initialize.headers.get("mcp-session-id")).toBeNull();

      const wrongPath = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
      });
      expect(wrongPath.status).toBe(404);
      expect(await wrongPath.json()).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32601, message: expect.stringContaining("/mcp") },
      });

      const wrongMethod = await fetch(url);
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("POST");
      expect(await wrongMethod.json()).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32601, message: expect.stringContaining("POST") },
      });

      // A declared 64 MB body is refused on the header, before a byte of it
      // is read. `fetch` will not send a content-length it cannot honour, so
      // this goes over a raw socket.
      const declared = await rawPost(Number(port), {
        headers: { "content-length": String(64 * 1024 * 1024) },
        body: '{"jsonrpc":"2.0","id":2,"method":"ping"}',
      });
      expect(declared).toContain("413");
      expect(declared).toContain('"code":-32600');

      // And a chunked body that never declares a length is cut off once the
      // counter passes the cap, rather than buffered to exhaustion.
      const chunked = await rawPost(Number(port), {
        headers: { "transfer-encoding": "chunked" },
        chunks: 21,
      });
      expect(chunked).not.toContain("200 OK");

      expect(stdout.join("")).toBe("");
    } finally {
      child.kill();
    }
  }, 30_000);

  it("binds loopback only, and SENDSPRITE_MCP_HOST overrides it", async () => {
    // The process holds a live API key and authenticates nobody, so the
    // default must not be reachable from the network.
    const listen = (extra: Record<string, string>) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [bin, "--http", "0"], {
          env: { ...env, ...extra },
        });
        let buffer = "";
        child.stderr.on("data", (c: Buffer) => {
          buffer += c.toString();
          if (buffer.includes("\n")) {
            child.kill();
            resolve(buffer);
          }
        });
        child.once("exit", () => reject(new Error(`exited: ${buffer}`)));
      });

    expect(await listen({})).toContain("http://127.0.0.1:");
    expect(await listen({ SENDSPRITE_MCP_HOST: "0.0.0.0" })).toContain(
      "http://0.0.0.0:",
    );
  }, 30_000);
});
