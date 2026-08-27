import type { CommandContext } from "../index";
import { DEFAULT_BASE_URL } from "../../client";
import { normalizeInstanceUrl, saveConfig } from "../config";

/** `sendsprite login --url <instance> --api-key <key>` */
export function registerLogin({ program, deps, write, run }: CommandContext) {
  program
    .command("login")
    .description("Save the instance URL and API key for this machine")
    .option(
      "--url <url>",
      `Instance origin for a self-hosted Sendsprite, e.g. https://mail.acme.com (default: ${DEFAULT_BASE_URL})`,
    )
    .option(
      "--api-key <key>",
      "API key (ss_live_…). Visible in `ps` and your shell history — prefer being prompted, or set SENDSPRITE_API_KEY",
    )
    .action(
      run(async (opts: { url?: string; apiKey?: string }) => {
        // The URL is never prompted for: the hosted instance is the answer
        // unless the operator says otherwise.
        const url = normalizeInstanceUrl(
          opts.url ?? (deps.env.SENDSPRITE_URL?.trim() || DEFAULT_BASE_URL),
          opts.url === undefined && deps.env.SENDSPRITE_URL
            ? "SENDSPRITE_URL"
            : "--url",
        );
        const apiKey = await resolve(
          opts.apiKey ?? deps.env.SENDSPRITE_API_KEY,
          "--api-key",
          "API key: ",
          deps.prompt,
          { mask: true },
        );
        // Check the credentials before writing them: a saved key that 401s is
        // worse than no key at all, because every later command blames itself.
        const me = await deps.createClient({ url, apiKey }).me();
        saveConfig(deps.configDir, { url, apiKey });
        write(
          `Logged in to ${me.team.name} as ${me.apiKey.name} (${me.apiKey.keyPrefix}…)`,
        );
      }),
    );
}

async function resolve(
  value: string | undefined,
  flag: string,
  question: string,
  prompt: CommandContext["deps"]["prompt"],
  opts?: { mask?: boolean },
): Promise<string> {
  const answer =
    value?.trim() || (prompt ? (await prompt(question, opts)).trim() : "");
  if (!answer) {
    throw new Error(
      `Missing ${flag}. Pass ${flag} <value>, or run this in a terminal to be prompted.`,
    );
  }
  return answer;
}
