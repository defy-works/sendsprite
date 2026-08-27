import type { HttpClient } from "../client";
import { renderElementLike } from "../render";
import type {
  BatchSendInput,
  BatchSendOptions,
  EmailDetail,
  EmailObject,
  ListEmailsParams,
  Page,
  PatchEmailInput,
  SendEmailInput,
  SendEmailOptions,
} from "../types";

export const enc = encodeURIComponent;

/**
 * Renders `react` (when present) into `html`/`text` — explicit `html`/`text`
 * win — and strips the element so the wire body is plain `SendEmailInput`.
 */
async function resolveReact(input: SendEmailOptions): Promise<SendEmailInput> {
  const { react, ...rest } = input;
  if (!react) return rest;
  const rendered = await renderElementLike(react);
  return {
    ...rest,
    html: rest.html ?? rendered.html,
    text: rest.text ?? rendered.text,
  };
}

export class Emails {
  constructor(private readonly http: HttpClient) {}

  /**
   * 201 `{ id }`; a replayed `idempotencyKey` returns the earlier id.
   * Retried on 429/5xx only when an `idempotencyKey` is set.
   */
  async send(input: SendEmailOptions): Promise<{ id: string }> {
    const body = await resolveReact(input);
    return this.http.request("POST", "/emails", {
      body,
      retry: Boolean(body.idempotencyKey),
    });
  }

  /** Up to 100 emails in one call; retried only when every item carries an `idempotencyKey`. */
  async batch(input: BatchSendOptions): Promise<{ data: { id: string }[] }> {
    const body: BatchSendInput = await Promise.all(input.map(resolveReact));
    return this.http.request("POST", "/emails/batch", {
      body,
      retry: body.every((e) => Boolean(e.idempotencyKey)),
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
