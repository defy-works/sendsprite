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
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const dist = join(root, "dist");
const bin = join(dist, "bin.js");

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
      const port = /http:\/\/localhost:(\d+)\/mcp/.exec(line)?.[1];
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
      const wrongMethod = await fetch(url);
      expect(wrongMethod.status).toBe(405);

      expect(stdout.join("")).toBe("");
    } finally {
      child.kill();
    }
  }, 30_000);
});
