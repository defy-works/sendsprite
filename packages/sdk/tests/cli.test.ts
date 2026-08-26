/**
 * The CLI is exercised through `buildProgram`'s injected dependencies — a fake
 * client, a `write` sink, an explicit config dir and env — so no process is
 * spawned and no real `~/.config` is touched. `tests/dist.test.ts` smokes the
 * built `dist/cli.js` binary itself.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  defaultConfigDir,
  loadConfig,
  normalizeInstanceUrl,
  saveConfig,
} from "../src/cli/config";
import { SendspriteError } from "../src/errors";
import { buildProgram } from "../src/cli/index";
import { table } from "../src/cli/output";
import type { TemplateObject } from "../src/types";

const dir = () => mkdtempSync(join(tmpdir(), "ss-cli-"));

const TEMPLATE: TemplateObject = {
  id: "tpl_1",
  slug: "welcome",
  name: "Welcome",
  subject: "Hi {{name}}",
  bodyHtml: "<p>Hi {{name}}</p>",
  bodyText: "Hi {{name}}",
  variablesSchema: { variables: [] },
  version: 1,
  updatedBy: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

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
  templates: {
    list: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
    create: vi.fn().mockResolvedValue(TEMPLATE),
    update: vi.fn().mockResolvedValue(TEMPLATE),
  },
  stream: vi.fn(),
});

type FakeClient = ReturnType<typeof fakeClient>;

const run = async (
  argv: string[],
  client: FakeClient = fakeClient(),
  configDir = dir(),
  env: NodeJS.ProcessEnv = {},
  prompt?: (question: string, opts?: { mask?: boolean }) => Promise<string>,
) => {
  const out: string[] = [];
  const err: string[] = [];
  const created: { url: string; apiKey: string }[] = [];
  const program = buildProgram({
    configDir,
    createClient: (cfg) => {
      created.push(cfg);
      return client as never;
    },
    write: (s) => out.push(s),
    writeError: (s) => err.push(s),
    env,
    prompt,
  });
  await program.parseAsync(["node", "sendsprite", ...argv]);
  return {
    out: out.join("\n"),
    lines: out,
    err: err.join("\n"),
    client,
    configDir,
    created,
  };
};

const loggedIn = () => {
  const d = dir();
  saveConfig(d, { url: "https://x", apiKey: "k" });
  return d;
};

describe("cli config", () => {
  it("prefers SENDSPRITE_CONFIG_DIR, then XDG, then the platform default", () => {
    // Resolved, so a relative value survives a change of directory.
    expect(defaultConfigDir({ SENDSPRITE_CONFIG_DIR: "explicit" })).toBe(
      resolve("explicit"),
    );
    expect(
      defaultConfigDir({
        SENDSPRITE_CONFIG_DIR: "/explicit",
        XDG_CONFIG_HOME: "/xdg",
      }),
    ).toBe(resolve("/explicit"));
    expect(
      defaultConfigDir({ XDG_CONFIG_HOME: "/xdg", APPDATA: "/appdata" }),
    ).toBe(join("/xdg", "sendsprite"));
    expect(defaultConfigDir({ APPDATA: "/appdata" }, "win32")).toBe(
      join("/appdata", "sendsprite"),
    );
    // The same env on a POSIX host must not take the %APPDATA% branch.
    expect(defaultConfigDir({ APPDATA: "/appdata" }, "linux")).toMatch(
      /sendsprite$/,
    );
    expect(defaultConfigDir({}, "linux")).toMatch(/sendsprite$/);
  });

  it("normalizes instance URLs and explains bad ones", () => {
    expect(normalizeInstanceUrl("https://mail.acme.com/")).toBe(
      "https://mail.acme.com",
    );
    // Copied from the API docs; the client appends /api/v1 itself, so leaving
    // it on would send every request to /api/v1/api/v1/....
    expect(normalizeInstanceUrl("https://mail.acme.com/api/v1")).toBe(
      "https://mail.acme.com",
    );
    expect(normalizeInstanceUrl("  https://mail.acme.com/api/v1/  ")).toBe(
      "https://mail.acme.com",
    );
    expect(normalizeInstanceUrl("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    // A sub-path deployment keeps its prefix.
    expect(normalizeInstanceUrl("https://acme.com/mail/")).toBe(
      "https://acme.com/mail",
    );
    expect(() => normalizeInstanceUrl("mail.acme.com")).toThrow(
      /not a valid URL/,
    );
    expect(() => normalizeInstanceUrl("mail.acme.com")).toThrow(
      /https:\/\/mail\.acme\.com/,
    );
    expect(() => normalizeInstanceUrl("ftp://mail.acme.com")).toThrow(
      /http\(s\) URL/,
    );
    expect(() => normalizeInstanceUrl("", "SENDSPRITE_URL")).toThrow(
      /SENDSPRITE_URL is not a valid URL/,
    );
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

  it("replaces the file atomically and leaves no temp behind", () => {
    const d = dir();
    saveConfig(d, { url: "https://x", apiKey: "old" });
    saveConfig(d, { url: "https://y", apiKey: "new" });
    expect(loadConfig(d)).toEqual({ url: "https://y", apiKey: "new" });
    expect(readdirSync(d)).toEqual(["config.json"]);
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

  it("login normalizes the URL it saves and rejects unusable ones", async () => {
    const d = dir();
    // The URL people copy out of the API reference. Left as-is, every later
    // request would go to /api/v1/api/v1/....
    await run(
      ["login", "--url", "https://mail.acme.com/api/v1/", "--api-key", "k"],
      fakeClient(),
      d,
    );
    expect(loadConfig(d)).toEqual({
      url: "https://mail.acme.com",
      apiKey: "k",
    });
    await expect(
      run(
        ["login", "--url", "mail.acme.com", "--api-key", "k"],
        fakeClient(),
        dir(),
      ),
    ).rejects.toThrow(/not a valid URL/);
    await expect(
      run(
        ["login", "--url", "ftp://mail.acme.com", "--api-key", "k"],
        fakeClient(),
        dir(),
      ),
    ).rejects.toThrow(/http\(s\) URL/);
  });

  it("login prompts for a missing key and asks for it to be masked", async () => {
    const asked: { question: string; mask: boolean }[] = [];
    const prompt = (question: string, opts?: { mask?: boolean }) => {
      asked.push({ question, mask: opts?.mask === true });
      return Promise.resolve(
        question.startsWith("API key") ? "ss_live_typed" : "https://typed.io",
      );
    };
    const d = dir();
    const { out } = await run(["login"], fakeClient(), d, {}, prompt);
    expect(asked).toEqual([
      { question: "Instance URL: ", mask: false },
      // The whole point of prompting instead of passing --api-key.
      { question: "API key: ", mask: true },
    ]);
    expect(loadConfig(d)).toEqual({
      url: "https://typed.io",
      apiKey: "ss_live_typed",
    });
    expect(out).not.toContain("ss_live_typed");
  });

  it("login mentions that --api-key is visible to other processes", () => {
    const help = buildProgram({
      configDir: dir(),
      createClient: () => fakeClient() as never,
      write: () => {},
      env: {},
    })
      .commands.find((c) => c.name() === "login")!
      .helpInformation();
    expect(help).toMatch(/ps` and your shell history/);
    expect(help).toMatch(/SENDSPRITE_API_KEY/);
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

  it("never mixes an env URL with the saved key, or the reverse", async () => {
    // `SENDSPRITE_URL=https://evil.test sendsprite whoami` on a logged-in
    // machine used to send the saved ss_live_ key to the attacker's host.
    const d = loggedIn();
    await expect(
      run(["whoami"], fakeClient(), d, {
        SENDSPRITE_URL: "https://evil.test",
      }),
    ).rejects.toThrow(/SENDSPRITE_API_KEY is not/);
    await expect(
      run(["whoami"], fakeClient(), d, { SENDSPRITE_API_KEY: "ss_live_env" }),
    ).rejects.toThrow(/SENDSPRITE_URL is not/);
    // Nothing was ever built, so nothing could have been sent.
    const half = await run(["whoami"], fakeClient(), d, {
      SENDSPRITE_URL: "https://evil.test",
    }).catch(() => null);
    expect(half).toBeNull();
    // A blank export is not "set" — it must not strand a logged-in machine.
    const blank = await run(["whoami"], fakeClient(), d, {
      SENDSPRITE_URL: "  ",
      SENDSPRITE_API_KEY: "",
    });
    expect(blank.created[0]).toEqual({ url: "https://x", apiKey: "k" });
  });

  it("normalizes SENDSPRITE_URL the same way as --url", async () => {
    const { created } = await run(["whoami"], fakeClient(), dir(), {
      SENDSPRITE_URL: "https://env.acme.com/api/v1/",
      SENDSPRITE_API_KEY: "ss_live_env",
    });
    expect(created[0]!.url).toBe("https://env.acme.com");
  });

  it("names the instance and the credential source when auth fails", async () => {
    // With env winning over the file, a stale exported key silently shadows a
    // fresh `login`; without this the operator has nothing to go on.
    const client = fakeClient();
    client.me.mockRejectedValue(
      new SendspriteError("unauthorized", "Invalid API key.", 401),
    );
    const fromFile = await run(["whoami"], client, loggedIn()).catch(
      (e: unknown) => e,
    );
    expect(String(fromFile)).toMatch(/Invalid API key/);
    expect(String(fromFile)).toMatch(/https:\/\/x .*the config file/s);
    const fromEnv = await run(["whoami"], client, loggedIn(), {
      SENDSPRITE_URL: "https://env.acme.com",
      SENDSPRITE_API_KEY: "ss_live_env",
    }).catch((e: unknown) => e);
    expect(String(fromEnv)).toMatch(
      /https:\/\/env\.acme\.com .*the environment/s,
    );
    // Errors that are not about credentials are left alone.
    client.me.mockRejectedValue(
      new SendspriteError("internal_error", "boom", 500),
    );
    const other = await run(["whoami"], client, loggedIn()).catch(
      (e: unknown) => e,
    );
    expect(String(other)).not.toMatch(/instance:/);
  });

  it("whoami --json prints the raw /me response", async () => {
    const { out } = await run(["whoami", "--json"], fakeClient(), loggedIn());
    expect(JSON.parse(out)).toEqual({
      team: { id: "t", name: "Acme" },
      apiKey: {
        id: "k",
        name: "ci",
        permission: "full",
        keyPrefix: "ss_live_ab",
        domainId: null,
      },
    });
  });

  it("never prints a full API key", async () => {
    // The one credential worth protecting: it must not reach stdout, stderr
    // or a thrown message from any command, however it was supplied.
    const key = "ss_live_supersecretvalue";
    const d = dir();
    const seen: string[] = [];
    const collect = (r: { out: string; err: string }) => {
      seen.push(r.out, r.err);
    };
    collect(
      await run(
        ["login", "--url", "https://mail.acme.com", "--api-key", key],
        fakeClient(),
        d,
      ),
    );
    collect(await run(["whoami"], fakeClient(), d));
    collect(await run(["whoami", "--json"], fakeClient(), d));
    collect(await run(["domains", "list"], fakeClient(), d));
    collect(
      await run(["whoami"], fakeClient(), dir(), {
        SENDSPRITE_URL: "https://x",
        SENDSPRITE_API_KEY: key,
      }),
    );
    const client = fakeClient();
    client.me.mockRejectedValue(
      new SendspriteError("unauthorized", "Invalid API key.", 401),
    );
    seen.push(
      String(await run(["whoami"], client, d).catch((e: unknown) => e)),
    );
    for (const text of seen) expect(text).not.toContain(key);
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

  it("domains list rejects a --limit that is not a page size", async () => {
    const d = loggedIn();
    for (const limit of ["abc", "0", "101", "2.5", ""]) {
      await expect(
        run(["domains", "list", "--limit", limit], fakeClient(), d),
        limit,
      ).rejects.toThrow(/1 to 100/);
    }
    const ok = await run(["domains", "list", "--limit", "10"], fakeClient(), d);
    expect(ok.client.domains.list).toHaveBeenCalledWith({ limit: 10 });
  });

  it("domains list aligns columns for non-ASCII names", () => {
    // `.length` counts an astral character twice and pads the column short.
    const emoji = String.fromCodePoint(0x1f600).repeat(2);
    const [header, row] = table([
      ["NAME", "STATUS"],
      [emoji, "verified"],
    ]);
    // Compared in code points, which is what the padding now counts.
    const column = (line: string, text: string) =>
      [...line.slice(0, line.indexOf(text))].length;
    expect(column(header!, "STATUS")).toBe(column(row!, "verified"));
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
    const { out, err } = await run(["emails", "tail"], client, loggedIn());
    expect(client.emails.get).toHaveBeenCalledTimes(1);
    // Diagnostics belong on stderr so stdout stays a clean stream of rows.
    expect(err).toContain("gone");
    expect(out).toBe("");
  });

  it("emails tail --json keeps stdout parseable on the error path", async () => {
    const client = fakeClient();
    client.emails.get
      .mockResolvedValueOnce({
        id: "em_1",
        status: "sent",
        to: ["c@d.io"],
        subject: "s",
      })
      .mockRejectedValueOnce(new Error("gone"));
    client.stream.mockImplementation(
      ({ onChange }: { onChange: (c: unknown) => void }) => {
        onChange({ type: "email", id: "em_1" });
        onChange({ type: "email", id: "em_2" });
        return { close() {}, done: Promise.resolve() };
      },
    );
    const { lines, err } = await run(
      ["emails", "tail", "--json"],
      client,
      loggedIn(),
    );
    // Every stdout line must survive `| jq`, failures included.
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { id: "em_1", status: "sent", to: ["c@d.io"], subject: "s" },
      { id: "em_2", error: "gone" },
    ]);
    expect(err).toBe("");
  });

  it("emails tail flushes rows already fetched when the stream fails", async () => {
    const client = fakeClient();
    client.stream.mockImplementation(
      ({ onChange }: { onChange: (c: unknown) => void }) => {
        onChange({ type: "email", id: "em_1" });
        return {
          close() {},
          done: Promise.reject(new Error("stream dropped")),
        };
      },
    );
    // Built here rather than through `run` so stdout is readable after the
    // rejection: a dropped connection must not swallow rows already fetched.
    const out: string[] = [];
    const program = buildProgram({
      configDir: loggedIn(),
      createClient: () => client as never,
      write: (line) => out.push(line),
      writeError: () => {},
      env: {},
    });
    await expect(
      program.parseAsync(["node", "sendsprite", "emails", "tail"]),
    ).rejects.toThrow(/stream dropped/);
    expect(client.emails.get).toHaveBeenCalledWith("em_1");
    expect(out.join("")).toMatch(/em_1/);
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

describe("cli templates pull/push", () => {
  /** A client whose team holds exactly `rows`, in one page. */
  const withRemote = (rows: TemplateObject[]) => {
    const client = fakeClient();
    client.templates.list.mockResolvedValue({ data: rows, nextCursor: null });
    return client;
  };

  const files = (
    d: string,
    slug: string,
    manifest: unknown,
    html: string,
    text?: string,
  ) => {
    writeFileSync(join(d, `${slug}.json`), JSON.stringify(manifest, null, 2));
    writeFileSync(join(d, `${slug}.html`), html);
    if (text !== undefined) writeFileSync(join(d, `${slug}.txt`), text);
  };

  it("pull writes a manifest, the HTML and the text body", async () => {
    const out = join(dir(), "nested");
    const { out: text } = await run(
      ["templates", "pull", out],
      withRemote([TEMPLATE]),
      loggedIn(),
    );
    expect(readFileSync(join(out, "welcome.html"), "utf8")).toBe(
      "<p>Hi {{name}}</p>",
    );
    expect(readFileSync(join(out, "welcome.txt"), "utf8")).toBe("Hi {{name}}");
    expect(JSON.parse(readFileSync(join(out, "welcome.json"), "utf8"))).toEqual(
      {
        name: "Welcome",
        subject: "Hi {{name}}",
        variablesSchema: { variables: [] },
      },
    );
    expect(text).toMatch(/wrote welcome/);
    expect(text).toMatch(/1 template, 1 changed/);
  });

  it("pull leaves no .txt behind for a template with no text body", async () => {
    const out = dir();
    // A stale file would otherwise be pushed straight back as a text body.
    writeFileSync(join(out, "welcome.txt"), "stale");
    await run(
      ["templates", "pull", out],
      withRemote([{ ...TEMPLATE, bodyText: null }]),
      loggedIn(),
    );
    expect(existsSync(join(out, "welcome.txt"))).toBe(false);
  });

  it("pull walks every page", async () => {
    const out = dir();
    const client = fakeClient();
    client.templates.list
      .mockResolvedValueOnce({ data: [TEMPLATE], nextCursor: "cur" })
      .mockResolvedValueOnce({
        data: [{ ...TEMPLATE, slug: "second" }],
        nextCursor: null,
      });
    await run(["templates", "pull", out], client, loggedIn());
    expect(client.templates.list).toHaveBeenNthCalledWith(2, {
      limit: 100,
      cursor: "cur",
    });
    expect(existsSync(join(out, "second.html"))).toBe(true);
  });

  it("pull --dry-run writes nothing", async () => {
    const out = dir();
    const { out: text } = await run(
      ["templates", "pull", out, "--dry-run"],
      withRemote([TEMPLATE]),
      loggedIn(),
    );
    expect(readdirSync(out)).toEqual([]);
    expect(text).toMatch(/would write welcome/);
    expect(text).toMatch(/1 template, 1 would change/);
  });

  it("pull refuses a slug that would escape the directory", async () => {
    await expect(
      run(
        ["templates", "pull", dir()],
        withRemote([{ ...TEMPLATE, slug: "../../etc/passwd" }]),
        loggedIn(),
      ),
    ).rejects.toThrow(/unexpected slug/);
  });

  it("pull reports a local template the instance does not have", async () => {
    const out = dir();
    files(out, "draft", { name: "D", subject: "s" }, "<p>d</p>");
    const { err } = await run(
      ["templates", "pull", out],
      withRemote([TEMPLATE]),
      loggedIn(),
    );
    expect(err).toMatch(/draft/);
    // Reported, never removed: it is unpushed work, not drift.
    expect(existsSync(join(out, "draft.json"))).toBe(true);
  });

  it("pull then push is a no-op", async () => {
    const out = dir();
    await run(["templates", "pull", out], withRemote([TEMPLATE]), loggedIn());
    const again = await run(
      ["templates", "pull", out],
      withRemote([TEMPLATE]),
      loggedIn(),
    );
    expect(again.out).toMatch(/unchanged welcome/);
    expect(again.out).toMatch(/1 template, 0 changed/);
    const client = withRemote([TEMPLATE]);
    const pushed = await run(["templates", "push", out], client, loggedIn());
    // A spurious PATCH here is a spurious version row on a live account.
    expect(client.templates.create).not.toHaveBeenCalled();
    expect(client.templates.update).not.toHaveBeenCalled();
    expect(pushed.out).toMatch(/unchanged welcome/);
    expect(pushed.out).toMatch(/1 template, 0 changed/);
  });

  it("push creates what is missing and patches only what changed", async () => {
    const out = dir();
    files(
      out,
      "welcome",
      {
        name: "Welcome",
        subject: "Hi {{name}}",
        variablesSchema: { variables: [] },
      },
      "<p>edited</p>",
      "Hi {{name}}",
    );
    files(out, "second", { name: "Second", subject: "Yo" }, "<p>Yo</p>");
    const client = withRemote([TEMPLATE]);
    const { out: text } = await run(
      ["templates", "push", out],
      client,
      loggedIn(),
    );
    expect(client.templates.create).toHaveBeenCalledWith({
      slug: "second",
      name: "Second",
      subject: "Yo",
      bodyHtml: "<p>Yo</p>",
    });
    // Only the field that moved: the audit diff names it, and nothing else is
    // re-sent to be compared.
    expect(client.templates.update).toHaveBeenCalledWith("welcome", {
      bodyHtml: "<p>edited</p>",
    });
    expect(text).toMatch(/created second/);
    expect(text).toMatch(/updated welcome \(bodyHtml\)/);
    expect(text).toMatch(/2 templates, 2 changed/);
  });

  it("push sends the variables schema and the text body it finds", async () => {
    const out = dir();
    files(
      out,
      "welcome",
      {
        name: "Welcome",
        subject: "Hi {{name}}",
        variablesSchema: { variables: [{ name: "name", type: "string" }] },
      },
      "<p>Hi {{name}}</p>",
      "Hi you",
    );
    const client = withRemote([TEMPLATE]);
    await run(["templates", "push", out], client, loggedIn());
    expect(client.templates.update).toHaveBeenCalledWith("welcome", {
      bodyText: "Hi you",
      variablesSchema: { variables: [{ name: "name", type: "string" }] },
    });
  });

  it("push never removes a text body it cannot see, and says so", async () => {
    const out = dir();
    files(
      out,
      "welcome",
      {
        name: "Welcome",
        subject: "Hi {{name}}",
        variablesSchema: { variables: [] },
      },
      "<p>Hi {{name}}</p>",
    );
    const client = withRemote([TEMPLATE]);
    const { out: text, err } = await run(
      ["templates", "push", out],
      client,
      loggedIn(),
    );
    expect(client.templates.update).not.toHaveBeenCalled();
    expect(text).toMatch(/unchanged welcome/);
    expect(err).toMatch(/welcome\.txt/);
  });

  it("push leaves a template with no local file alone and reports it", async () => {
    const out = dir();
    files(out, "welcome", { name: "Welcome", subject: "Hi" }, "<p>Hi</p>");
    const client = withRemote([TEMPLATE, { ...TEMPLATE, slug: "orphaned" }]);
    const { err } = await run(["templates", "push", out], client, loggedIn());
    expect(err).toMatch(/orphaned/);
    expect(err).toMatch(/never deletes/);
  });

  it("push --dry-run reports the same plan and sends nothing", async () => {
    const out = dir();
    files(out, "a", { name: "A", subject: "s" }, "<p>a</p>");
    files(
      out,
      "welcome",
      {
        name: "Welcome",
        subject: "Hi {{name}}",
        variablesSchema: { variables: [] },
      },
      "<p>edited</p>",
      "Hi {{name}}",
    );
    const client = withRemote([TEMPLATE]);
    const { out: text } = await run(
      ["templates", "push", out, "--dry-run"],
      client,
      loggedIn(),
    );
    expect(client.templates.create).not.toHaveBeenCalled();
    expect(client.templates.update).not.toHaveBeenCalled();
    expect(text).toMatch(/would create a/);
    expect(text).toMatch(/would update welcome \(bodyHtml\)/);
    expect(text).toMatch(/2 templates, 2 would change/);
  });

  it("push names the file and the problem for anything malformed", async () => {
    const client = () => withRemote([]);
    const orphan = dir();
    writeFileSync(join(orphan, "orphan.json"), '{"name":"O","subject":"s"}');
    await expect(
      run(["templates", "push", orphan], client(), loggedIn()),
    ).rejects.toThrow(/orphan\.html/);

    const bad = dir();
    writeFileSync(join(bad, "Not A Slug.json"), "{}");
    await expect(
      run(["templates", "push", bad], client(), loggedIn()),
    ).rejects.toThrow(/Not A Slug\.json.*slug/s);

    const broken = dir();
    writeFileSync(join(broken, "b.json"), "{ not json");
    writeFileSync(join(broken, "b.html"), "<p>b</p>");
    await expect(
      run(["templates", "push", broken], client(), loggedIn()),
    ).rejects.toThrow(/b\.json: not valid JSON/);

    const bare = dir();
    files(bare, "a", { subject: "s" }, "<p>a</p>");
    await expect(
      run(["templates", "push", bare], client(), loggedIn()),
    ).rejects.toThrow(/a\.json: "name"/);

    const stray = dir();
    files(
      stray,
      "a",
      { name: "A", subject: "s", bodyHtml: "<p>a</p>" },
      "<p>a</p>",
    );
    await expect(
      run(["templates", "push", stray], client(), loggedIn()),
    ).rejects.toThrow(/a\.json.*bodyHtml.*a\.html/s);

    await expect(
      run(["templates", "push", join(dir(), "absent")], client(), loggedIn()),
    ).rejects.toThrow(/Cannot read/);
  });

  it("push validates the whole directory before it sends anything", async () => {
    const out = dir();
    files(out, "a", { name: "A", subject: "s" }, "<p>a</p>");
    writeFileSync(join(out, "b.json"), "{ not json");
    writeFileSync(join(out, "b.html"), "<p>b</p>");
    const client = withRemote([]);
    await expect(
      run(["templates", "push", out], client, loggedIn()),
    ).rejects.toThrow(/b\.json/);
    // Half a directory pushed is worse than none of it.
    expect(client.templates.create).not.toHaveBeenCalled();
    expect(client.templates.list).not.toHaveBeenCalled();
  });

  it("push ignores an .html with no manifest but says it did", async () => {
    const out = dir();
    files(out, "a", { name: "A", subject: "s" }, "<p>a</p>");
    writeFileSync(join(out, "stray.html"), "<p>stray</p>");
    const { err } = await run(
      ["templates", "push", out],
      withRemote([]),
      loggedIn(),
    );
    expect(err).toMatch(/stray\.html/);
  });
});
