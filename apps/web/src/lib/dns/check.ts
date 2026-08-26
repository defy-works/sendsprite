import { promises as dns } from "node:dns";
import type { ExpectedRecord } from "@/db/schema/domains";
import { normaliseTxt } from "@/lib/cloudflare/client";

export interface Resolver {
  resolveCname(name: string): Promise<string[]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolveTxt(name: string): Promise<string[][]>;
}

/**
 * Resolves through public resolvers (Cloudflare, Google) rather than the
 * host's configured ones, so the check reflects what the world sees: a
 * self-hosted box often sits behind a split-horizon or caching resolver that
 * would show stale or internal-only answers. Requires outbound UDP/TCP port
 * 53 to 1.1.1.1 and 8.8.8.8; a firewall that blocks it makes every check
 * fail (timeouts read as "not ok").
 *
 * CNAME caveat: a provider that flattens CNAMEs (Cloudflare does so at the
 * zone apex, some do everywhere) answers with the target's A/AAAA records
 * instead of the CNAME, so a flattened DKIM CNAME shows as not-ok here even
 * though SES may still verify it. SES remains the authority on DKIM.
 */
export function publicResolver(): Resolver {
  const r = new dns.Resolver({ timeout: 3000, tries: 2 });
  r.setServers(["1.1.1.1", "8.8.8.8"]);
  return {
    resolveCname: (n) => r.resolveCname(n),
    resolveMx: (n) => r.resolveMx(n),
    resolveTxt: (n) => r.resolveTxt(n),
  };
}

/** Hostnames compare case-insensitively and without a trailing dot. */
const host = (s: string) => s.toLowerCase().replace(/\.$/, "");
/** TXT answers arrive as chunks; join, then normalise like the Cloudflare side. */
const txt = (chunks: string[]) => normaliseTxt(chunks.join("")).toLowerCase();

/**
 * Kind-aware presence check. SPF/DMARC are judged on what matters for mail
 * rather than byte equality, since operators legitimately extend them
 * (extra `include:`s, `pct=`, a different `rua=`):
 * - MAIL_FROM_SPF: a `v=spf1` TXT at the name with an `include:amazonses.com`
 *   term (whole token: `include:amazonses.com.evil.net` does not count).
 * - DMARC: any `v=DMARC1` TXT at `_dmarc.<domain>`.
 * - CNAME/MX: exact target (MX priority is informational).
 */
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
    const answers = (await res.resolveTxt(rec.name)).map(txt);
    if (rec.kind === "MAIL_FROM_SPF")
      return answers.some(
        (a) =>
          a.startsWith("v=spf1") &&
          /(^|\s)include:amazonses\.com(\s|$)/.test(a),
      );
    if (rec.kind === "DMARC")
      return answers.some((a) => a.startsWith("v=dmarc1"));
    return answers.includes(txt([rec.value]));
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
