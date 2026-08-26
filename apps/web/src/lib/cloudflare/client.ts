export interface CfZone {
  id: string;
  name: string;
}
export interface CfRecordInput {
  type: "CNAME" | "MX" | "TXT";
  name: string;
  content: string;
  priority?: number;
  ttl?: number;
  proxied?: boolean;
}
export interface CfRecord extends CfRecordInput {
  id: string;
}

/** What the client needs from `fetch`; narrower than `typeof fetch` so tests can pass a plain function. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Cloudflare v4 API error (`errors[0]` of the response body) plus the HTTP status. */
export class CloudflareError extends Error {
  constructor(
    msg: string,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(msg);
    this.name = "CloudflareError";
  }
}

/** Cloudflare error code for "record does not exist". */
const RECORD_NOT_FOUND = 81044;

interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: { code: number; message: string }[];
  result_info?: { page?: number; total_pages?: number };
}

/** TXT content as DNS sees it: one pair of surrounding quotes off, whitespace collapsed. */
export const normaliseTxt = (s: string) =>
  s
    .trim()
    .replace(/^"(.*)"$/s, "$1")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Key a TXT record for upsert. SPF (RFC 7208 §3.2) and DMARC (RFC 7489
 * §6.6.3) allow at most one record per name: a second SPF is a permerror and
 * a second DMARC means no policy. So those are keyed by their `v=` prefix and
 * an existing one is updated in place. Any other TXT (verification tokens,
 * etc.) is keyed by its exact content, since several may share a name.
 */
export function txtKey(content: string): string {
  const c = normaliseTxt(content);
  if (/^v=spf1\b/i.test(c)) return "v=spf1";
  if (/^v=dmarc1\b/i.test(c)) return "v=dmarc1";
  return c;
}

/**
 * Minimal Cloudflare v4 client. `f` (fetch) is injectable for tests.
 * `token` is an OAuth access token (see services/cloudflare-connect.ts);
 * the v4 API takes it as a bearer exactly like an API token, so nothing
 * here is OAuth-specific. `listZones` doubles as the liveness check —
 * `/user/tokens/verify` only answers for API tokens, not OAuth grants.
 * Zones are paged (100/page); records at one name are not (more than 100
 * records at a single name is out of scope).
 */
export class CloudflareClient {
  constructor(
    private token: string,
    private f: FetchLike = fetch,
    private base = "https://api.cloudflare.com/client/v4",
  ) {}

  private async envelope<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<CfEnvelope<T>> {
    const res = await this.f(`${this.base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as CfEnvelope<T>;
    if (!res.ok || body.success === false) {
      const e = body.errors?.[0];
      throw new CloudflareError(
        e?.message ?? `Cloudflare ${res.status}`,
        e?.code,
        res.status,
      );
    }
    return body;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.envelope<T>(path, init)).result as T;
  }

  async listZones(): Promise<CfZone[]> {
    const zones: CfZone[] = [];
    for (let page = 1, total = 1; page <= total; page++) {
      const env = await this.envelope<CfZone[]>(
        `/zones?per_page=100&status=active&page=${page}`,
      );
      zones.push(...(env.result ?? []));
      total = env.result_info?.total_pages ?? 1;
    }
    return zones;
  }

  listRecords(zoneId: string, q: { type?: string; name?: string } = {}) {
    const p = new URLSearchParams({
      per_page: "100",
      ...(q.type && { type: q.type }),
      ...(q.name && { name: q.name }),
    });
    return this.call<CfRecord[]>(`/zones/${zoneId}/dns_records?${p}`);
  }

  /**
   * Create or update a record. CNAME/MX are keyed by (type, name): one record
   * per name, so an existing one is patched. TXT is keyed by `txtKey`:
   * SPF/DMARC by prefix (one per name), everything else by exact content.
   */
  async upsertRecord(
    zoneId: string,
    r: CfRecordInput,
  ): Promise<{ id: string }> {
    const body = { ttl: 1, proxied: false, ...r };
    const existing = await this.listRecords(zoneId, {
      type: r.type,
      name: r.name,
    });
    const match = existing.find(
      (e) =>
        e.type === r.type &&
        e.name === r.name &&
        (r.type !== "TXT" || txtKey(e.content) === txtKey(r.content)),
    );
    if (match)
      return this.call(`/zones/${zoneId}/dns_records/${match.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    return this.call(`/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** Idempotent: a record already gone (404 / code 81044) counts as deleted. */
  async deleteRecord(zoneId: string, id: string): Promise<{ id: string }> {
    try {
      return await this.call<{ id: string }>(
        `/zones/${zoneId}/dns_records/${id}`,
        { method: "DELETE" },
      );
    } catch (e) {
      if (
        e instanceof CloudflareError &&
        (e.status === 404 || e.code === RECORD_NOT_FOUND)
      )
        return { id };
      throw e;
    }
  }
}
