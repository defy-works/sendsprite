import type { HttpClient } from "../client";
import type {
  CreateDomainInput,
  DomainObject,
  Page,
  PageParams,
} from "../types";
import { enc } from "./emails";

export class Domains {
  constructor(private readonly http: HttpClient) {}

  list(params: PageParams = {}): Promise<Page<DomainObject>> {
    return this.http.request("GET", "/domains", {
      query: { limit: params.limit, cursor: params.cursor },
    });
  }

  create(input: CreateDomainInput): Promise<DomainObject> {
    return this.http.request("POST", "/domains", { body: input });
  }

  get(id: string): Promise<DomainObject> {
    return this.http.request("GET", `/domains/${enc(id)}`);
  }

  /** Re-check DNS now. Safe to retry. */
  verify(id: string): Promise<DomainObject> {
    return this.http.request("POST", `/domains/${enc(id)}/verify`, {
      retry: true,
    });
  }

  /**
   * Resolves `undefined` (204) when everything was cleaned up, or
   * `{ leftoverDnsRecords }` (200) with the number of Cloudflare records that
   * could not be removed automatically and need manual cleanup.
   */
  delete(id: string): Promise<{ leftoverDnsRecords: number } | void> {
    return this.http.request("DELETE", `/domains/${enc(id)}`);
  }
}
