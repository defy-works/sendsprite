/**
 * The CLI is exercised through `buildProgram`'s injected dependencies — a fake
 * client, a `write` sink, an explicit config dir and env — so no process is
 * spawned and no real `~/.config` is touched. `tests/dist.test.ts` smokes the
 * built `dist/cli.js` binary itself.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfigDir, loadConfig, saveConfig } from "../src/cli/config";
import { buildProgram } from "../src/cli/index";

const dir = () => mkdtempSync(join(tmpdir(), "ss-cli-"));

const fakeClient = () => ({
  me: vi.fn().mockResolvedValue({
    team: { id: "t", name: "Acme" },
    apiKey: {
      id: "k",
      name: "ci",
      permission: "full",
      keyPrefix: "ss_live_ab",
      domainId: null,
    },
  }),
  domains: {
    list: vi.fn().mockResolvedValue({
      data: [
        {
          id: "d1",
          name: "mail.x.io",
          status: "verified",
          dnsMode: "cloudflare",
          region: "us-east-1",
          records: [],
          lastError: null,
          createdAt: "",
          verifiedAt: "",
        },
      ],
      nextCursor: null,
    }),
  },
  emails: {
    send: vi.fn().mockResolvedValue({ id: "em_1" }),
    get: vi.fn().mockResolvedValue({
      id: "em_1",
      status: "sent",
      to: ["c@d.io"],
      subject: "s",
    }),
  },
  stream: vi.fn(),
});

type FakeClient = ReturnType<typeof fakeClient>;

const run = async (
  argv: string[],
  client: FakeClient = fakeClient(),
  configDir = dir(),
  env: NodeJS.ProcessEnv = {},
) => {
  const out: string[] = [];
  const created: { url: string; apiKey: string }[] = [];
  const program = buildProgram({
    configDir,
    createClient: (cfg) => {
      created.push(cfg);
      return client as never;
    },
    write: (s) => out.push(s),
    env,
  });
  await program.parseAsync(["node", "sendsprite", ...argv]);
  return { out: out.join("\n"), client, configDir, created };
};

const loggedIn = () => {
  const d = dir();
  saveConfig(d, { url: "https://x", apiKey: "k" });
  return d;
};

describe("cli config", () => {
  it("prefers SENDSPRITE_CONFIG_DIR, then XDG, then the platform default", () => {
    expect(defaultConfigDir({ SENDSPRITE_CONFIG_DIR: "/explicit" })).toBe(
      "/explicit",
    );
    expect(defaultConfigDir({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      join("/xdg", "sendsprite"),
    );
    expect(defaultConfigDir({})).toMatch(/sendsprite$/);
  });

  it("round-trips the config and returns null when there is none", () => {
    const d = dir();
    expect(loadConfig(d)).toBeNull();
    saveConfig(d, { url: "https://x", apiKey: "k" });
    expect(loadConfig(d)).toEqual({ url: "https://x", apiKey: "k" });
  });

  it("treats a malformed config as absent", () => {
    const d = dir();
    writeFileSync(join(d, "config.json"), "{ not json");
    expect(loadConfig(d)).toBeNull();
  });

  it("writes config.json owner-only", () => {
    const d = dir();
    saveConfig(d, { url: "https://x", apiKey: "k" });
    const mode = statSync(join(d, "config.json")).mode & 0o777;
    // Windows does not implement POSIX modes; everywhere else it must be 0600.
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });
});

describe("cli", () => {
  it("login saves url + key and verifies with /me", async () => {
    const { out, configDir, client } = await run([
      "login",
      "--url",
      "https://mail.acme.com",
      "--api-key",
      "ss_live_1",
    ]);
    expect(client.me).toHaveBeenCalled();
    expect(loadConfig(configDir)).toEqual({
      url: "https://mail.acme.com",
      apiKey: "ss_live_1",
    });
    expect(out).toContain("Logged in to Acme");
    expect(readFileSync(join(configDir, "config.json"), "utf8")).toContain(
      "ss_live_1",
    );
  });

  it("login does not save credentials that /me rejects", async () => {
    const client = fakeClient();
    client.me.mockRejectedValue(new Error("HTTP 401"));
    const d = dir();
    await expect(
      run(["login", "--url", "https://x", "--api-key", "bad"], client, d),
    ).rejects.toThrow(/401/);
    expect(loadConfig(d)).toBeNull();
  });

  it("login without flags on a non-TTY explains what is missing", async () => {
    await expect(run(["login"])).rejects.toThrow(/--url/);
  });

  it("whoami prints team and key", async () => {
    const { out } = await run(["whoami"], fakeClient(), loggedIn());
    expect(out).toMatch(/Acme.*t/s);
    expect(out).toContain("ss_live_ab");
  });

  it("commands other than login fail clearly when not logged in", async () => {
    await expect(run(["whoami"])).rejects.toThrow(/sendsprite login/);
  });

  it("env credentials work with no config file and override it", async () => {
    const env = {
      SENDSPRITE_URL: "https://env.acme.com",
      SENDSPRITE_API_KEY: "ss_live_env",
    };
    const bare = await run(["whoami"], fakeClient(), dir(), env);
    expect(bare.created[0]).toEqual({
      url: "https://env.acme.com",
      apiKey: "ss_live_env",
    });
    const over = await run(["whoami"], fakeClient(), loggedIn(), env);
    expect(over.created[0]).toEqual({
      url: "https://env.acme.com",
      apiKey: "ss_live_env",
    });
  });

  it("domains list renders a table and --json raw", async () => {
    const d = loggedIn();
    expect((await run(["domains", "list"], fakeClient(), d)).out).toMatch(
      /mail\.x\.io\s+verified/,
    );
    expect(
      JSON.parse(
        (await run(["domains", "list", "--json"], fakeClient(), d)).out,
      )[0].id,
    ).toBe("d1");
  });

  it("emails send maps flags to SendEmailInput", async () => {
    const { client, out } = await run(
      [
        "emails",
        "send",
        "--from",
        "a@b.io",
        "--to",
        "c@d.io",
        "--to",
        "e@f.io",
        "--subject",
        "hi",
        "--text",
        "body",
        "--tag",
        "env=ci",
      ],
      fakeClient(),
      loggedIn(),
    );
    expect(client.emails.send).toHaveBeenCalledWith({
      from: "a@b.io",
      to: ["c@d.io", "e@f.io"],
      subject: "hi",
      text: "body",
      tags: { env: "ci" },
    });
    expect(out).toContain("em_1");
  });

  it("emails send reads --html-file and passes the optional fields through", async () => {
    const d = loggedIn();
    const file = join(d, "body.html");
    writeFileSync(file, "<h1>hi</h1>");
    const { client } = await run(
      [
        "emails",
        "send",
        "--from",
        "a@b.io",
        "--to",
        "c@d.io",
        "--cc",
        "cc@d.io",
        "--reply-to",
        "r@d.io",
        "--subject",
        "hi",
        "--html-file",
        file,
        "--schedule",
        "2030-01-01T00:00:00.000Z",
        "--idempotency-key",
        "key-1",
      ],
      fakeClient(),
      d,
    );
    expect(client.emails.send).toHaveBeenCalledWith({
      from: "a@b.io",
      to: ["c@d.io"],
      cc: ["cc@d.io"],
      replyTo: ["r@d.io"],
      subject: "hi",
      html: "<h1>hi</h1>",
      scheduledAt: "2030-01-01T00:00:00.000Z",
      idempotencyKey: "key-1",
    });
  });

  it("emails send rejects a malformed --tag", async () => {
    await expect(
      run(
        [
          "emails",
          "send",
          "--from",
          "a@b.io",
          "--to",
          "c@d.io",
          "--subject",
          "hi",
          "--text",
          "b",
          "--tag",
          "nope",
        ],
        fakeClient(),
        loggedIn(),
      ),
    ).rejects.toThrow(/key=value/);
  });

  it("emails send requires a body", async () => {
    await expect(
      run(
        [
          "emails",
          "send",
          "--from",
          "a@b.io",
          "--to",
          "c@d.io",
          "--subject",
          "hi",
        ],
        fakeClient(),
        loggedIn(),
      ),
    ).rejects.toThrow(/--text/);
  });

  it("emails tail subscribes to the stream and prints email changes", async () => {
    const client = fakeClient();
    client.stream.mockImplementation(
      ({ onChange }: { onChange: (c: unknown) => void }) => {
        onChange({ type: "email", id: "em_1" });
        return { close() {}, done: Promise.resolve() };
      },
    );
    const { out } = await run(["emails", "tail"], client, loggedIn());
    expect(client.emails.get).toHaveBeenCalledWith("em_1");
    expect(out).toMatch(/em_1\s+sent\s+c@d\.io\s+s/);
  });

  it("emails tail ignores non-email changes and survives a failed lookup", async () => {
    const client = fakeClient();
    client.emails.get.mockRejectedValue(new Error("gone"));
    client.stream.mockImplementation(
      ({ onChange }: { onChange: (c: unknown) => void }) => {
        onChange({ type: "webhook", id: "wh_1" });
        onChange({ type: "email", id: "em_1" });
        return { close() {}, done: Promise.resolve() };
      },
    );
    const { out } = await run(["emails", "tail"], client, loggedIn());
    expect(client.emails.get).toHaveBeenCalledTimes(1);
    expect(out).toContain("gone");
  });

  it("emails tail closes the stream on SIGINT and removes its listener", async () => {
    const before = process.listenerCount("SIGINT");
    const client = fakeClient();
    const close = vi.fn();
    client.stream.mockImplementation(() => ({
      close,
      done: new Promise<void>((resolve) => {
        close.mockImplementation(() => resolve());
        setTimeout(() => process.emit("SIGINT", "SIGINT"), 0);
      }),
    }));
    await run(["emails", "tail"], client, loggedIn());
    expect(close).toHaveBeenCalled();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
