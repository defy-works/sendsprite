/**
 * `npx sendsprite`'s credential file: `<config dir>/config.json`, owner-only.
 * The environment always wins over the file, so CI can set
 * `SENDSPRITE_URL`/`SENDSPRITE_API_KEY` without a login step.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliConfig {
  /** Instance origin, e.g. `https://mail.acme.com` (no `/api/v1`). */
  url: string;
  apiKey: string;
}

const FILE = "config.json";

/**
 * `$SENDSPRITE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/sendsprite`, else
 * `%APPDATA%\sendsprite` on Windows, else `~/.config/sendsprite`.
 */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SENDSPRITE_CONFIG_DIR) return env.SENDSPRITE_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "sendsprite");
  if (process.platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "sendsprite");
  }
  return join(homedir(), ".config", "sendsprite");
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
    return { url, apiKey };
  } catch {
    return null;
  }
}

/** Writes `config.json` with mode 0600, creating the directory if needed. */
export function saveConfig(dir: string, config: CliConfig): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, FILE);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; an existing one keeps its
  // old permissions, so narrow them explicitly. Windows has no POSIX modes.
  if (process.platform !== "win32") chmodSync(file, 0o600);
}
