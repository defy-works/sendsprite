import type { HttpClient } from "../client";
import type {
  CreateWebhookInput,
  Page,
  PageParams,
  UpdateWebhookInput,
  WebhookCreated,
  WebhookObject,
  WebhookTestAccepted,
} from "../types";
import { enc } from "./emails";

export class Webhooks {
  constructor(private readonly http: HttpClient) {}

  list(params: PageParams = {}): Promise<Page<WebhookObject>> {
    return this.http.request("GET", "/webhooks", {
      query: { limit: params.limit, cursor: params.cursor },
    });
  }

  /** The signing `secret` is only ever returned here. */
  create(input: CreateWebhookInput): Promise<WebhookCreated> {
    return this.http.request("POST", "/webhooks", { body: input });
  }

  update(id: string, input: UpdateWebhookInput): Promise<WebhookObject> {
    return this.http.request("PATCH", `/webhooks/${enc(id)}`, { body: input });
  }

  /** Enqueue a test delivery (202). Safe to retry. */
  test(id: string): Promise<WebhookTestAccepted> {
    return this.http.request("POST", `/webhooks/${enc(id)}/test`, {
      retry: true,
    });
  }

  delete(id: string): Promise<void> {
    return this.http.request("DELETE", `/webhooks/${enc(id)}`);
  }
}
