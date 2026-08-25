/**
 * `npx sendsprite`'s credential file: `<config dir>/config.json`, owner-only.
 * Reading it is `loadConfig`; deciding whether it is even consulted is
 * `resolveCredentials` in `./index.ts`.
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CliConfig {
  /** Instance origin, e.g. `https://mail.acme.com` (no `/api/v1`). */
  url: string;
  apiKey: string;
}

const FILE = "config.json";

/**
 * `$SENDSPRITE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/sendsprite`, else
 * `%APPDATA%\sendsprite` on Windows, else `~/.config/sendsprite`.
 *
 * `platform` is a parameter so the Windows branch is reachable from a test on
 * any host.
 */
export function defaultConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  // Resolved against the cwd: a relative `SENDSPRITE_CONFIG_DIR` must not mean
  // a different directory once a command changes directory.
  if (env.SENDSPRITE_CONFIG_DIR) return resolve(env.SENDSPRITE_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "sendsprite");
  if (platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "sendsprite");
  }
  return join(homedir(), ".config", "sendsprite");
}

/**
 * Validates an instance URL and reduces it to the origin the SDK wants.
 *
 * The client appends `/api/v1`, so a URL copied from the API docs
 * (`https://mail.acme.com/api/v1`) would otherwise produce requests to
 * `/api/v1/api/v1/me` — a 404 that reads like a broken server.
 *
 * @throws {Error} with a usable hint, rather than the bare `TypeError:
 * Invalid URL` the WHATWG parser throws from deep inside the client.
 */
export function normalizeInstanceUrl(raw: string, source = "--url"): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `${source} is not a valid URL: ${JSON.stringify(trimmed)}. Use the full origin, e.g. https://mail.acme.com.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `${source} must be an http(s) URL, got ${url.protocol}//. Use the full origin, e.g. https://mail.acme.com.`,
    );
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return `${url.origin}${path}`;
}

/** The saved credentials, or `null` when there are none we can use. */
export function loadConfig(dir: string): CliConfig | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { url, apiKey } = parsed as Partial<CliConfig>;
    // A half-written file is no better than no file: make the caller log in
    // again rather than fail later with a confusing 401.
    if (typeof url !== "string" || typeof apiKey !== "string") return null;
    if (url === "" || apiKey === "") return null;
    return { url, apiKey };
  } catch {
    return null;
  }
}

/**
 * Writes `config.json` with mode 0600. The write goes to a temp file in the
 * same directory and is renamed into place, so an interrupted `login` cannot
 * leave a truncated file where working credentials used to be.
 */
export function saveConfig(dir: string, config: CliConfig): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, FILE);
  const temp = join(dir, `.${FILE}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; narrow it explicitly in case
  // the temp name already existed. Windows has no POSIX modes.
  if (process.platform !== "win32") chmodSync(temp, 0o600);
  renameSync(temp, file);
}
