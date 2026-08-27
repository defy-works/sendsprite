import type { HttpClient } from "../client";
import type {
  ApiKeyCreated,
  ApiKeyObject,
  CreateApiKeyInput,
  Page,
  PageParams,
} from "../types";
import { enc } from "./emails";

export class ApiKeys {
  constructor(private readonly http: HttpClient) {}

  list(params: PageParams = {}): Promise<Page<ApiKeyObject>> {
    return this.http.request("GET", "/api-keys", {
      query: { limit: params.limit, cursor: params.cursor },
    });
  }

  /** The `secret` is only ever returned here. */
  create(input: CreateApiKeyInput): Promise<ApiKeyCreated> {
    return this.http.request("POST", "/api-keys", { body: input });
  }

  revoke(id: string): Promise<void> {
    return this.http.request("DELETE", `/api-keys/${enc(id)}`);
  }
}
