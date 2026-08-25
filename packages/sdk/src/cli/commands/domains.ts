import type { CommandContext } from "../index";
import { table } from "../output";

/** `sendsprite domains list` */
export function registerDomains({ program, client, write }: CommandContext) {
  const domains = program
    .command("domains")
    .description("Sending domains")
    .exitOverride();

  domains
    .command("list")
    .description("List sending domains")
    .option("--json", "Print the raw array")
    .option("--limit <n>", "Page size, 1–100", (value) => Number(value))
    .action(async (opts: { json?: boolean; limit?: number }) => {
      const page = await client().domains.list(
        opts.limit === undefined ? {} : { limit: opts.limit },
      );
      if (opts.json) {
        write(JSON.stringify(page.data, null, 2));
        return;
      }
      const rows = [
        ["NAME", "STATUS", "MODE", "REGION", "ID"],
        ...page.data.map((d) => [d.name, d.status, d.dnsMode, d.region, d.id]),
      ];
      for (const line of table(rows)) write(line);
      // A `nextCursor` here means the account has more domains than one page.
      if (page.nextCursor) write(`… more (--limit up to 100)`);
    });
}
