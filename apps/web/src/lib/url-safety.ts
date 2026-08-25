/**
 * Is `raw` an http(s) URL whose host is not an obviously private target?
 * Pure, syntactic: it rejects `localhost`, `*.localhost`, `*.local`,
 * `*.internal`, single-label hosts and literal IPs in loopback, RFC 1918,
 * link-local (incl. the cloud metadata address 169.254.169.254), CGNAT,
 * "this network", multicast/reserved, IPv6 loopback/unspecified, ULA and
 * link-local ranges, plus IPv4-mapped IPv6 forms of those.
 *
 * It does not resolve DNS; `isPublicIp` is the check to run on the
 * resolved addresses before connecting (webhook delivery does).
 */
export function isPublicHttpUrl(
  raw: string,
  opts: { httpsOnly?: boolean } = {},
): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && (opts.httpsOnly || u.protocol !== "http:"))
    return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (!host) return false;
  if (host.startsWith("[")) return isPublicIpv6(host.slice(1, -1));
  const v4 = parseIpv4(host);
  if (v4) return isPublicIpv4(v4);
  if (host === "localhost") return false;
  if (/\.(localhost|local|internal)$/.test(host)) return false;
  if (!host.includes(".")) return false;
  return true;
}

/**
 * Is `ip` (a bare IPv4/IPv6 literal, as `dns.lookup` returns it) outside
 * every private, loopback, link-local, CGNAT and reserved range above?
 * Anything unparseable is not public.
 */
export function isPublicIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isPublicIpv4(v4);
  if (ip.includes(":")) return isPublicIpv6(ip.toLowerCase());
  return false;
}

function parseIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function isPublicIpv4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return false; // this net, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local (incl. 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return false; // private 172.16/12
  if (a === 192 && b === 168) return false; // private 192.168/16
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/**
 * `ip` as the URL parser gives it: compressed, lowercase, no brackets. The
 * WHATWG serializer writes IPv4-mapped addresses in hex (`::ffff:7f00:1`);
 * the dotted form is handled too for callers that bypass `new URL`.
 */
function isPublicIpv6(ip: string): boolean {
  if (ip === "::1" || ip === "::") return false;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (dotted || hex) {
    const v4 = dotted
      ? parseIpv4(dotted[1]!)
      : [hex![1]!, hex![2]!].flatMap((h) => {
          const n = parseInt(h, 16);
          return [n >> 8, n & 0xff];
        });
    return v4 ? isPublicIpv4(v4) : false;
  }
  const first = ip.split(":")[0] ?? "";
  if (/^f[cd]/.test(first)) return false; // ULA fc00::/7
  if (/^fe[89ab]/.test(first)) return false; // link-local fe80::/10
  return true;
}
