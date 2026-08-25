import type { HttpClient } from "../client";
import type {
  AddSuppressionInput,
  Page,
  PageParams,
  SuppressionObject,
} from "../types";
import { enc } from "./emails";

export class Suppressions {
  constructor(private readonly http: HttpClient) {}

  list(params: PageParams = {}): Promise<Page<SuppressionObject>> {
    return this.http.request("GET", "/suppressions", {
      query: { limit: params.limit, cursor: params.cursor },
    });
  }

  add(input: AddSuppressionInput): Promise<SuppressionObject> {
    return this.http.request("POST", "/suppressions", { body: input });
  }

  /** Remove by address; the email is URL-encoded as a single path segment. */
  remove(email: string): Promise<void> {
    return this.http.request("DELETE", `/suppressions/${enc(email)}`);
  }
}
