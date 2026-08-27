import type { ExpectedRecord } from "@/db/schema/domains";

const TTL = 3600;

/** A name as an absolute zone entry: exactly one trailing dot. */
const fqdn = (name: string) => (name.endsWith(".") ? name : `${name}.`);

/**
 * TXT rdata: quoted, `"` and `\` escaped, and split into 255-byte strings if
 * longer (a single quoted string cannot exceed 255 bytes — RFC 1035 §3.3.14).
 * SES's SPF and DMARC values are short, but the split is the correct general
 * form and costs nothing on a value that does not need it.
 */
function txt(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (escaped.length <= 255) return `"${escaped}"`;
  const parts: string[] = [];
  for (let i = 0; i < escaped.length; i += 255)
    parts.push(`"${escaped.slice(i, i + 255)}"`);
  return parts.join(" ");
}

function line(r: ExpectedRecord): string {
  const name = fqdn(r.name);
  switch (r.type) {
    case "CNAME":
      return `${name}\t${TTL}\tIN\tCNAME\t${fqdn(r.value)}`;
    case "MX":
      return `${name}\t${TTL}\tIN\tMX\t${r.priority ?? 10} ${fqdn(r.value)}`;
    case "TXT":
      return `${name}\t${TTL}\tIN\tTXT\t${txt(r.value)}`;
  }
}

/** A DNS-safe basename for the download: `sendsprite-<domain>.zone`. */
export const bindZoneFilename = (domain: string) =>
  `sendsprite-${domain.replace(/[^a-zA-Z0-9.-]/g, "_")}.zone`;

/**
 * The domain's SES records as a BIND zone fragment — the file a self-hoster
 * uploads instead of typing six records by hand (Cloudflare, Route 53 and
 * BIND all import this format).
 *
 * Absolute names (trailing dots) throughout, so it imports the same whatever
 * `$ORIGIN` a provider assumes; the `$ORIGIN`/`$TTL` lines are there for the
 * ones that want them. No SOA or NS: this **adds** records to an existing
 * zone, it does not define one, and an SOA would make a provider think it is
 * replacing the whole zone. Deterministic — no timestamp — so re-downloading
 * the same domain gives a byte-identical file.
 */
export function toBindZone(domain: string, records: ExpectedRecord[]): string {
  return [
    `; Sendsprite DNS records for ${domain}`,
    `; Upload to your DNS provider (Cloudflare: DNS > Records > Import).`,
    `; These add to your zone; your existing records are untouched.`,
    `$ORIGIN ${fqdn(domain)}`,
    `$TTL ${TTL}`,
    ``,
    ...records.map(line),
    ``,
  ].join("\n");
}
