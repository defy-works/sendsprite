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

/** Cloudflare v4 API error (`errors[0]` of the response body). */
export class CloudflareError extends Error {
  constructor(
    msg: string,
    readonly code?: number,
  ) {
    super(msg);
    this.name = "CloudflareError";
  }
}

interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: { code: number; message: string }[];
}

/**
 * Minimal Cloudflare v4 client. `f` (fetch) is injectable for tests.
 * Lists use `per_page=100` without paging: an instance with more than 100
 * zones, or more than 100 records at one name, is out of scope for Phase 2.
 */
export class CloudflareClient {
  constructor(
    private token: string,
    private f: FetchLike = fetch,
    private base = "https://api.cloudflare.com/client/v4",
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
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
      );
    }
    return body.result as T;
  }

  verifyToken() {
    return this.call<{ status: string }>("/user/tokens/verify");
  }

  listZones() {
    return this.call<CfZone[]>("/zones?per_page=100&status=active");
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
   * per name, so an existing one is patched. TXT is keyed by
   * (type, name, content): several TXT records at one name are normal (SPF
   * next to verification tokens), so a different content is created rather
   * than overwriting a neighbour.
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
        (r.type !== "TXT" || e.content === r.content),
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

  deleteRecord(zoneId: string, id: string) {
    return this.call<{ id: string }>(`/zones/${zoneId}/dns_records/${id}`, {
      method: "DELETE",
    });
  }
}
