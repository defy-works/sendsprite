import type { CommandContext } from "../index";
import { saveConfig } from "../config";

/** `sendsprite login --url <instance> --api-key <key>` */
export function registerLogin({ program, deps, write }: CommandContext): void {
  program
    .command("login")
    .description("Save the instance URL and API key for this machine")
    .option("--url <url>", "Instance origin, e.g. https://mail.acme.com")
    .option("--api-key <key>", "API key (ss_live_…)")
    .action(async (opts: { url?: string; apiKey?: string }) => {
      const url = await resolve(
        opts.url ?? deps.env.SENDSPRITE_URL,
        "--url",
        "Instance URL: ",
        deps.prompt,
      );
      const apiKey = await resolve(
        opts.apiKey ?? deps.env.SENDSPRITE_API_KEY,
        "--api-key",
        "API key: ",
        deps.prompt,
      );
      // Check the credentials before writing them: a saved key that 401s is
      // worse than no key at all, because every later command blames itself.
      const me = await deps.createClient({ url, apiKey }).me();
      saveConfig(deps.configDir, { url, apiKey });
      write(
        `Logged in to ${me.team.name} as ${me.apiKey.name} (${me.apiKey.keyPrefix}…)`,
      );
    });
}

async function resolve(
  value: string | undefined,
  flag: string,
  question: string,
  prompt: ((question: string) => Promise<string>) | undefined,
): Promise<string> {
  const answer = value ?? (prompt ? (await prompt(question)).trim() : "");
  if (!answer) {
    throw new Error(
      `Missing ${flag}. Pass ${flag} <value>, or run this in a terminal to be prompted.`,
    );
  }
  return answer;
}
