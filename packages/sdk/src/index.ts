export { SendspriteError, type SendspriteErrorCode } from "./errors";
export {
  type SendspriteOptions,
  type RequestOptions,
  SDK_VERSION,
  DEFAULT_BASE_URL,
} from "./client";
export type { StreamOptions, StreamHandle } from "./stream";
export type { Emails } from "./resources/emails";
export type { Domains } from "./resources/domains";
export type { ApiKeys } from "./resources/api-keys";
export type { Webhooks } from "./resources/webhooks";
export type { Suppressions } from "./resources/suppressions";
export type { Templates } from "./resources/templates";
export type { ContactBooks } from "./resources/contact-books";
export type { Contacts } from "./resources/contacts";
export type { Campaigns } from "./resources/campaigns";
export * from "./types";

import {
  HttpClient,
  type RequestOptions,
  type SendspriteOptions,
} from "./client";
import { ApiKeys } from "./resources/api-keys";
import { Campaigns } from "./resources/campaigns";
import { ContactBooks } from "./resources/contact-books";
import { Contacts } from "./resources/contacts";
import { Domains } from "./resources/domains";
import { Emails } from "./resources/emails";
import { Suppressions } from "./resources/suppressions";
import { Templates } from "./resources/templates";
import { Webhooks } from "./resources/webhooks";
import { openStream, type StreamHandle, type StreamOptions } from "./stream";
import type { MeObject, SendStatsObject } from "./types";

/** Sendsprite API client: `new Sendsprite({ apiKey, baseUrl })`. */
export class Sendsprite {
  readonly emails: Emails;
  readonly domains: Domains;
  readonly apiKeys: ApiKeys;
  readonly webhooks: Webhooks;
  readonly suppressions: Suppressions;
  readonly templates: Templates;
  readonly contactBooks: ContactBooks;
  readonly contacts: Contacts;
  readonly campaigns: Campaigns;
  private readonly http: HttpClient;

  constructor(options?: SendspriteOptions) {
    this.http = new HttpClient(options);
    this.emails = new Emails(this.http);
    this.domains = new Domains(this.http);
    this.apiKeys = new ApiKeys(this.http);
    this.webhooks = new Webhooks(this.http);
    this.suppressions = new Suppressions(this.http);
    this.templates = new Templates(this.http);
    this.contactBooks = new ContactBooks(this.http);
    this.contacts = new Contacts(this.http);
    this.campaigns = new Campaigns(this.http);
  }

  /** Instance origin with `/api/v1` not yet appended. */
  get baseUrl(): string {
    return this.http.baseUrl;
  }

  /** Escape hatch for endpoints without a helper; `path` is relative to `/api/v1`. */
  request<T = unknown>(
    method: string,
    path: string,
    options?: RequestOptions,
  ): Promise<T> {
    return this.http.request<T>(method, path, options);
  }

  /** Aggregate send/deliverability counters for the team. */
  stats(): Promise<SendStatsObject> {
    return this.http.request("GET", "/stats");
  }

  /** The team and key behind the current credentials. */
  me(): Promise<MeObject> {
    return this.http.request("GET", "/me");
  }

  /** Live change feed (`GET /api/v1/stream`, SSE); requires a `full` key. */
  stream(options: StreamOptions): StreamHandle {
    return openStream(this.http, options);
  }
}
