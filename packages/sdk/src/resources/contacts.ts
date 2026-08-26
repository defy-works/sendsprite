import type { HttpClient } from "../client";
import type {
  ContactObject,
  CreateContactInput,
  ListContactsParams,
  Page,
  UnsubscribeContactInput,
  UnsubscribeResult,
  UpdateContactInput,
} from "../types";
import { enc } from "./emails";

/**
 * Contacts inside a book. Requires a `full` key.
 *
 * A contact's `subscribed` flag is consent for one book. It is not the
 * suppression list, which is team-wide and blocks every send including
 * transactional mail — `suppressions` is that surface.
 */
export class Contacts {
  constructor(private readonly http: HttpClient) {}

  private base(bookId: string): string {
    return `/contact-books/${enc(bookId)}/contacts`;
  }

  list(
    bookId: string,
    params: ListContactsParams = {},
  ): Promise<Page<ContactObject>> {
    return this.http.request("GET", this.base(bookId), {
      query: {
        limit: params.limit,
        cursor: params.cursor,
        q: params.q,
        // The server takes `true`/`false` as a string enum, so a typo is a
        // 400 rather than quietly meaning `true`.
        subscribed:
          params.subscribed === undefined
            ? undefined
            : String(params.subscribed),
      },
    });
  }

  /** Walks every page of `list()` for one book, starting from the first. */
  async *iterate(
    bookId: string,
    params: Omit<ListContactsParams, "cursor"> = {},
  ): AsyncGenerator<ContactObject, void, undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.list(bookId, { ...params, cursor });
      yield* page.data;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  get(bookId: string, id: string): Promise<ContactObject> {
    return this.http.request("GET", `${this.base(bookId)}/${enc(id)}`);
  }

  create(bookId: string, input: CreateContactInput): Promise<ContactObject> {
    return this.http.request("POST", this.base(bookId), { body: input });
  }

  update(
    bookId: string,
    id: string,
    input: UpdateContactInput,
  ): Promise<ContactObject> {
    return this.http.request("PATCH", `${this.base(bookId)}/${enc(id)}`, {
      body: input,
    });
  }

  remove(bookId: string, id: string): Promise<void> {
    return this.http.request("DELETE", `${this.base(bookId)}/${enc(id)}`);
  }

  /**
   * Records consent withdrawal for an address across every book of the team
   * (or one, with `bookId`). Idempotent — an address already out answers
   * `{ unsubscribed: 0 }` — so it is safe to retry.
   *
   * This is **not** the suppression list: it does not stop transactional mail.
   * Use `suppressions.add()` for that.
   */
  unsubscribe(input: UnsubscribeContactInput): Promise<UnsubscribeResult> {
    return this.http.request("POST", "/contacts/unsubscribe", {
      body: input,
      retry: true,
    });
  }
}
