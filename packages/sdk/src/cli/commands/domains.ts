import type { CommandContext } from "../index";
import { table } from "../output";

/** `sendsprite domains list` */
export function registerDomains({
  program,
  client,
  write,
  run,
}: CommandContext) {
  const domains = program
    .command("domains")
    .description("Sending domains")
    .exitOverride();

  domains
    .command("list")
    .description("List sending domains")
    .option("--json", "Print the raw array")
    .option("--limit <n>", "Page size, 1-100", pageSize)
    .action(
      run(async (opts: { json?: boolean; limit?: number }) => {
        const page = await client().domains.list(
          opts.limit === undefined ? {} : { limit: opts.limit },
        );
        if (opts.json) {
          write(JSON.stringify(page.data, null, 2));
          return;
        }
        const rows = [
          ["NAME", "STATUS", "MODE", "REGION", "ID"],
          ...page.data.map((d) => [
            d.name,
            d.status,
            d.dnsMode,
            d.region,
            d.id,
          ]),
        ];
        for (const line of table(rows)) write(line);
        // A `nextCursor` here means the account has more domains than one page.
        if (page.nextCursor) write("... more (--limit up to 100)");
      }),
    );
}

/** `--limit abc` used to reach the API as `NaN`, which drops the parameter. */
function pageSize(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(
      `Invalid --limit ${JSON.stringify(value)}: use a whole number from 1 to 100.`,
    );
  }
  return limit;
}
