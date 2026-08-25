import type { CommandContext } from "../index";
import { field } from "../output";

/** `sendsprite whoami` */
export function registerWhoami({
  program,
  client,
  write,
  run,
}: CommandContext) {
  program
    .command("whoami")
    .description("Show the team and API key behind the saved credentials")
    .option("--json", "Print the raw /me response")
    .action(
      run(async (opts: { json?: boolean }) => {
        const me = await client().me();
        if (opts.json) {
          write(JSON.stringify(me, null, 2));
          return;
        }
        write(field("Team", `${me.team.name} (${me.team.id})`));
        write(
          field(
            "Key",
            `${me.apiKey.name} (${me.apiKey.keyPrefix}…) \u00b7 ${me.apiKey.permission}`,
          ),
        );
      }),
    );
}
