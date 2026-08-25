/**
 * The published surface, end to end against the running instance: the built
 * `sendsprite` bundle, the built `npx sendsprite` binary, and the built
 * `@sendsprite/mcp` server driven by a real MCP client.
 *
 * The **built** artefacts on purpose — `dist/`, not `src/`. Everything the
 * package tests cover runs against source; what only shows up in a bundle
 * (a `noExternal` that did not inline, a missing `bin` shebang, a
 * dependency that resolves in the workspace but not from the tarball's own
 * `node_modules`) shows up here. `test:e2e` builds both packages first.
 *
 * `dist/` is gitignored, so the imports below are *runtime* imports of a file
 * that may not exist when `tsc` runs; the types come from the packages'
 * sources instead, which keeps `bun run typecheck` working on a fresh clone.
 *
 * Credentials come from setup.spec.ts (the `setup` project, which the `app`
 * project depends on) through ./credentials. The domain is this file's own:
 * setup.spec.ts and send.spec.ts each delete theirs, and send.spec.ts's team
 * is a different one, so there is no verified domain to inherit. Creating it
 * here through the SDK is also the only coverage `domains.create`/`verify`
 * get against a real server.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test, type TestInfo } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  DomainObject,
  Sendsprite,
  SendspriteOptions,
  StreamHandle,
} from "../../../../packages/sdk/src/index";
import { baseUrl, loadApiKey } from "./credentials";

const SDK_DIST = new URL(
  "../../../../packages/sdk/dist/index.js",
  import.meta.url,
);
const MCP_DIST = new URL(
  "../../../../packages/mcp/dist/index.js",
  import.meta.url,
);
const CLI_DIST = fileURLToPath(
  new URL("../../../../packages/sdk/dist/cli.js", import.meta.url),
);

type SendspriteCtor = new (options?: SendspriteOptions) => Sendsprite;
/** `createServer` as `@sendsprite/mcp` exports it; typed here so `dist` is not needed to compile. */
type CreateServer = (client: Sendsprite) => McpServer;

/** The tests share one verified domain, so they must not interleave. */
test.describe.configure({ mode: "serial" });

let base: string;
let apiKey: string;
let client: Sendsprite;
let domain: DomainObject;
/**
 * Held here, not in the test that opens it: a test that fails or times out
 * never reaches its own `close()`, and afterEach runs either way. An SSE
 * connection is the one thing this suite opens that outlives the test body,
 * and leaving one attached to `next dev` after the run should have finished
 * is how a red spec turns into a wedged job.
 */
let feed: StreamHandle | undefined;

/** Provisioning is a background job; `verify` is a conflict until it has stored the DKIM tokens. */
async function provisionDomain(name: string): Promise<DomainObject> {
  const created = await client.domains.create({ name });
  expect(created.id).toMatch(/^dom_/);
  expect(created.status).toBe("pending");
  await expect
    .poll(async () => (await client.domains.get(created.id)).records.length, {
      timeout: 60_000,
      message: "domain provisioning never produced DNS records",
    })
    .toBeGreaterThan(0);
  // The server runs with AWS_E2E_VERIFY=1, so the fake SES reports DKIM and
  // MAIL FROM as SUCCESS and one check is enough (same path as the dashboard's
  // Re-verify button).
  const verified = await client.domains.verify(created.id);
  expect(verified.status, verified.lastError ?? "").toBe("verified");
  return verified;
}

test.beforeAll(async () => {
  const info: TestInfo = test.info();
  base = baseUrl(info);
  apiKey = loadApiKey(info);
  const { Sendsprite } = (await import(SDK_DIST.href)) as {
    Sendsprite: SendspriteCtor;
  };
  // 60 s rather than the SDK's 30 s default: `next dev` compiles a route on
  // its first hit, which is seconds on a cold CI runner, and that budget now
  // also covers the stream's connect (see `StreamHandle.ready`).
  client = new Sendsprite({ apiKey, baseUrl: base, timeoutMs: 60_000 });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  domain = await provisionDomain(`mail.e2e-sdk-${suffix}.com`);
});

test.afterEach(async () => {
  const open = feed;
  feed = undefined;
  open?.close();
  await open?.done.catch(() => undefined);
});

test.afterAll(async () => {
  // Names are unique instance-wide; leaving them only clutters the dev database.
  if (client && domain) await client.domains.delete(domain.id).catch(() => {});
});

test("SDK: me, domains.list, emails.send + get, and stream sees the change", async () => {
  const me = await client.me();
  expect(me.apiKey.permission).toBe("full");
  // `team.id` is the auth provider's organization id, which carries no prefix.
  expect(me.team.id).not.toBe("");
  expect(apiKey.startsWith(me.apiKey.keyPrefix)).toBe(true);

  const domains = await client.domains.list();
  expect(domains.data.map((d) => d.id)).toContain(domain.id);
  expect(domains.data.find((d) => d.id === domain.id)?.status).toBe("verified");

  const seen: string[] = [];
  const stream = (feed = client.stream({
    onChange: (change) => {
      if (change.type === "email" && change.id) seen.push(change.id);
    },
    reconnect: false,
  }));
  // Opening the stream is not the same as having it: the request still has to
  // reach a route `next dev` may only now be compiling, and a `queued`/`sent`
  // change emitted before the server has the subscription is gone for good —
  // no timeout can recover a missed event. `ready` is the server's own
  // confirmation (its `: connected` frame), and it rejects rather than hangs
  // if the stream never opens.
  await stream.ready;

  const { id } = await client.emails.send({
    from: `hi@${domain.name}`,
    to: "dest@example.com",
    subject: "sdk e2e",
    text: "hello from the sdk",
    tags: { suite: "sdk-e2e" },
  });
  expect(id).toMatch(/^em_/);

  await expect
    .poll(async () => (await client.emails.get(id)).status, {
      timeout: 60_000,
      message: "the inline worker never moved the email to `sent`",
    })
    .toBe("sent");

  const detail = await client.emails.get(id);
  expect(detail.to).toEqual(["dest@example.com"]);
  expect(detail.events.map((e) => e.type)).toContain("sent");

  await expect
    .poll(() => seen.includes(id), {
      message: "the SSE stream never reported the email",
    })
    .toBe(true);
  // afterEach closes it too; doing it here as well is what proves `close()`
  // and `done` behave on a stream that really was live.
  stream.close();
  await stream.done;
});

test("CLI: whoami, domains list --json and emails send, on env credentials", async () => {
  const env = {
    ...process.env,
    SENDSPRITE_URL: base,
    SENDSPRITE_API_KEY: apiKey,
    // Never touch the developer's real ~/.config/sendsprite.
    SENDSPRITE_CONFIG_DIR: test.info().outputPath("cli-config"),
  };
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, [CLI_DIST, ...args], {
      env,
      encoding: "utf8",
    });

  expect(cli("whoami")).toMatch(/Key\s+.*·\s*full/);

  const listed = JSON.parse(cli("domains", "list", "--json")) as DomainObject[];
  const mine = listed.find((d) => d.id === domain.id);
  expect(mine?.status).toBe("verified");

  const sent = cli(
    "emails",
    "send",
    "--from",
    `hi@${domain.name}`,
    "--to",
    "dest@example.com",
    "--subject",
    "cli e2e",
    "--text",
    "hello from the cli",
  );
  expect(sent).toMatch(/Queued em_/);

  const id = /em_[A-Za-z0-9_-]+/.exec(sent)![0];
  await expect
    .poll(async () => (await client.emails.get(id)).status, { timeout: 60_000 })
    .toBe("sent");
});

test("MCP: get_send_stats, list_domains and send_email over an in-memory transport", async () => {
  const { createServer } = (await import(MCP_DIST.href)) as {
    createServer: CreateServer;
  };
  const server = createServer(client);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "sendsprite-e2e", version: "0" });
  await mcp.connect(clientSide);

  try {
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual([
      "send_email",
      "get_email_status",
      "list_emails",
      "search_emails",
      "list_domains",
      "get_send_stats",
    ]);

    const stats = await mcp.callTool({ name: "get_send_stats", arguments: {} });
    expect(stats.isError, JSON.stringify(stats.content)).toBeFalsy();
    const sent = (stats.structuredContent as { sent: { today: number } }).sent;
    // The SDK and CLI tests above both sent one.
    expect(sent.today).toBeGreaterThanOrEqual(2);

    const domains = await mcp.callTool({ name: "list_domains", arguments: {} });
    expect(domains.isError, JSON.stringify(domains.content)).toBeFalsy();
    const page = domains.structuredContent as { data: { id: string }[] };
    expect(page.data.map((d) => d.id)).toContain(domain.id);

    const send = await mcp.callTool({
      name: "send_email",
      arguments: {
        from: `hi@${domain.name}`,
        to: "dest@example.com",
        subject: "mcp e2e",
        text: "hello from mcp",
      },
    });
    expect(send.isError, JSON.stringify(send.content)).toBeFalsy();
    const { id } = send.structuredContent as { id: string };
    expect(id).toMatch(/^em_/);

    const status = await mcp.callTool({
      name: "get_email_status",
      arguments: { id },
    });
    expect(status.isError, JSON.stringify(status.content)).toBeFalsy();
    expect((status.structuredContent as { subject: string }).subject).toBe(
      "mcp e2e",
    );
  } finally {
    await mcp.close();
    await server.close();
  }
});
