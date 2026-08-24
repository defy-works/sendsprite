import { promises as dns } from "node:dns";
import type { ExpectedRecord } from "@/db/schema/domains";

export interface Resolver {
  resolveCname(name: string): Promise<string[]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolveTxt(name: string): Promise<string[][]>;
}

/**
 * Resolves through public resolvers (Cloudflare, Google) rather than the
 * host's configured ones, so the check reflects what the world sees: a
 * self-hosted box often sits behind a split-horizon or caching resolver that
 * would show stale or internal-only answers.
 */
export function publicResolver(): Resolver {
  const r = new dns.Resolver();
  r.setServers(["1.1.1.1", "8.8.8.8"]);
  return {
    resolveCname: (n) => r.resolveCname(n),
    resolveMx: (n) => r.resolveMx(n),
    resolveTxt: (n) => r.resolveTxt(n),
  };
}

/** Hostnames compare case-insensitively and without a trailing dot. */
const host = (s: string) => s.toLowerCase().replace(/\.$/, "");
/** TXT answers arrive as chunks; join them and normalise whitespace. */
const txt = (chunks: string[]) => chunks.join("").replace(/\s+/g, " ").trim();

/** MX compares the exchange only: the priority is informational. */
async function present(rec: ExpectedRecord, res: Resolver): Promise<boolean> {
  try {
    if (rec.type === "CNAME")
      return (await res.resolveCname(rec.name)).some(
        (v) => host(v) === host(rec.value),
      );
    if (rec.type === "MX")
      return (await res.resolveMx(rec.name)).some(
        (m) => host(m.exchange) === host(rec.value),
      );
    return (await res.resolveTxt(rec.name)).some(
      (chunks) => txt(chunks) === txt([rec.value]),
    );
  } catch {
    // NXDOMAIN, NODATA, timeouts: the record is not (yet) visible.
    return false;
  }
}

/** Re-evaluates `ok` for each record against live DNS. Does not mutate input. */
export async function checkRecords(
  recs: ExpectedRecord[],
  res: Resolver = publicResolver(),
): Promise<ExpectedRecord[]> {
  return Promise.all(
    recs.map(async (r) => ({ ...r, ok: await present(r, res) })),
  );
}
