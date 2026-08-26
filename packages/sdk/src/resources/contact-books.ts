import type { HttpClient } from "../client";
import type {
  ContactBookObject,
  CreateContactBookInput,
  ImportContactsInput,
  ImportContactsResult,
  Page,
  PageParams,
  UpdateContactBookInput,
} from "../types";
import { enc } from "./emails";

/** Contact books: the container a contact lives in. Requires a `full` key. */
export class ContactBooks {
  constructor(private readonly http: HttpClient) {}

  list(params: PageParams = {}): Promise<Page<ContactBookObject>> {
    return this.http.request("GET", "/contact-books", {
      query: { limit: params.limit, cursor: params.cursor },
    });
  }

  get(id: string): Promise<ContactBookObject> {
    return this.http.request("GET", `/contact-books/${enc(id)}`);
  }

  create(input: CreateContactBookInput): Promise<ContactBookObject> {
    return this.http.request("POST", "/contact-books", { body: input });
  }

  update(
    id: string,
    input: UpdateContactBookInput,
  ): Promise<ContactBookObject> {
    return this.http.request("PATCH", `/contact-books/${enc(id)}`, {
      body: input,
    });
  }

  /** Deletes every contact in the book. */
  remove(id: string): Promise<void> {
    return this.http.request("DELETE", `/contact-books/${enc(id)}`);
  }

  /**
   * CSV import. Up to 2 MB and 10 000 rows per call — split a bigger list.
   *
   * Rows that fail do **not** fail the call: this resolves with a report
   * (`imported`, `updated`, `skipped`, `duplicates` and the first 100
   * `errors` with their line numbers) and the good rows land. Inspect the
   * report; a resolved promise is not "everything imported".
   *
   * Not retried: a repeated partial import is an upsert, but the counts in
   * the first response would then be wrong, which is worse than a visible
   * failure.
   */
  import(
    id: string,
    input: ImportContactsInput,
  ): Promise<ImportContactsResult> {
    return this.http.request(
      "POST",
      `/contact-books/${enc(id)}/contacts/import`,
      { body: input },
    );
  }
}
