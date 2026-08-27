import type { Resolver } from "./check";

/**
 * Cloudflare's assigned nameservers are always a pair under this suffix
 * (`kate.ns.cloudflare.com`, etc.). Custom nameservers (an Enterprise
 * feature that serves the same zones under the operator's own names) do not
 * match, so a zone using them reads as "not on Cloudflare" and simply gets
 * the manual instructions — a false negative, never a false positive.
 */
const CF_NS = /(^|\.)ns\.cloudflare\.com$/i;

const host = (s: string) => s.toLowerCase().replace(/\.$/, "");

/**
 * Deep link to a zone's DNS records in the Cloudflare dashboard. `:account`
 * is a placeholder Cloudflare resolves against the signed-in user, so we
 * never need to know their account id — which is the whole point: this link
 * works with no credentials of any kind on our side.
 *
 * It lands on the records list; the values still have to be entered there,
 * since Cloudflare has no documented way to prefill the add-record form.
 * (That page also carries **Import and Export**, which accepts a BIND file —
 * a way to cut the copy-paste down to one upload if we ever generate one.)
 */
export const cloudflareDnsUrl = (zone: string) =>
  `https://dash.cloudflare.com/?to=/:account/${encodeURIComponent(host(zone))}/dns/records`;

/**
 * The delegation point for `name` and whether Cloudflare serves it.
 *
 * A sending domain is usually a subdomain (`mail.example.com`) with no NS
 * records of its own, so the zone that actually holds the records is found
 * by walking up one label at a time until a name answers NS. That is the
 * cut point in the DNS tree, and it needs no public-suffix list: for
 * `mail.example.co.uk` the walk passes `example.co.uk` (which answers) and
 * stops there.
 *
 * Returns the zone name when its nameservers are Cloudflare's, `null`
 * otherwise — including on timeouts, so a resolver problem degrades to the
 * manual instructions rather than showing a link that goes nowhere.
 */
export async function detectCloudflareZone(
  name: string,
  res: Resolver,
): Promise<string | null> {
  const labels = host(name).split(".");
  // Stop at the last two labels: a bare TLD is never a zone we can link to.
  for (let i = 0; i <= labels.length - 2; i++) {
    const candidate = labels.slice(i).join(".");
    let ns: string[];
    try {
      ns = await res.resolveNs(candidate);
    } catch {
      // NODATA here just means "not the delegation point"; keep walking.
      continue;
    }
    if (ns.length === 0) continue;
    return ns.every((n) => CF_NS.test(host(n))) ? candidate : null;
  }
  return null;
}
