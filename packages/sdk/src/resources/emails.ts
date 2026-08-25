import type { HttpClient } from "../client";
import type {
  BatchSendInput,
  EmailDetail,
  EmailObject,
  ListEmailsParams,
  Page,
  PatchEmailInput,
  SendEmailInput,
} from "../types";

export const enc = encodeURIComponent;

export class Emails {
  constructor(private readonly http: HttpClient) {}

  /**
   * 201 `{ id }`; a replayed `idempotencyKey` returns the earlier id.
   * Retried on 429/5xx only when an `idempotencyKey` is set.
   */
  send(input: SendEmailInput): Promise<{ id: string }> {
    return this.http.request("POST", "/emails", {
      body: input,
      retry: Boolean(input.idempotencyKey),
    });
  }

  /** Up to 100 emails in one call; retried only when every item carries an `idempotencyKey`. */
  batch(input: BatchSendInput): Promise<{ data: { id: string }[] }> {
    return this.http.request("POST", "/emails/batch", {
      body: input,
      retry: input.every((e) => Boolean(e.idempotencyKey)),
    });
  }

  get(id: string): Promise<EmailDetail> {
    return this.http.request("GET", `/emails/${enc(id)}`);
  }

  list(params: ListEmailsParams = {}): Promise<Page<EmailObject>> {
    return this.http.request("GET", "/emails", {
      query: {
        limit: params.limit,
        cursor: params.cursor,
        status: params.status,
        to: params.to,
        domainId: params.domainId,
        tag: params.tag,
      },
    });
  }

  /** Cancel a `scheduled` email. Safe to retry. */
  cancel(id: string): Promise<EmailObject> {
    return this.http.request("POST", `/emails/${enc(id)}/cancel`, {
      retry: true,
    });
  }

  /** Move a `scheduled` email to a new future time. */
  reschedule(id: string, input: PatchEmailInput): Promise<EmailObject> {
    return this.http.request("PATCH", `/emails/${enc(id)}`, { body: input });
  }

  /** Walks every page of `list()` starting from the first. */
  async *iterate(
    params: Omit<ListEmailsParams, "cursor"> = {},
  ): AsyncGenerator<EmailObject, void, undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...params, cursor });
      yield* page.data;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
}
