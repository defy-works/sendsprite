import type { HttpClient } from "../client";
import type {
  CreateTemplateInput,
  Page,
  PageParams,
  RenderedTemplateObject,
  TemplateDetail,
  TemplateObject,
  UpdateTemplateInput,
} from "../types";
import { enc } from "./emails";

/**
 * Stored, versioned templates. Every method needs a `full` key — these are
 * management endpoints, `render()` included, because it returns template
 * content.
 *
 * There is no `rename()`: a template's slug is what a live `POST /emails`
 * names it by, so changing it would be a silent production break. A rename is
 * `create()` under the new slug plus `remove()` of the old one.
 */
export class Templates {
  constructor(private readonly http: HttpClient) {}

  list(params: PageParams = {}): Promise<Page<TemplateObject>> {
    return this.http.request("GET", "/templates", {
      query: { limit: params.limit, cursor: params.cursor },
    });
  }

  /** Walks every page of `list()` starting from the first. */
  async *iterate(): AsyncGenerator<TemplateObject, void, undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ cursor });
      yield* page.data;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  /** By slug or by `tpl_…` id; includes the version history. */
  get(slug: string): Promise<TemplateDetail> {
    return this.http.request("GET", `/templates/${enc(slug)}`);
  }

  create(input: CreateTemplateInput): Promise<TemplateObject> {
    return this.http.request("POST", "/templates", { body: input });
  }

  /** Partial update; `slug` is not accepted (see the class note). */
  update(slug: string, input: UpdateTemplateInput): Promise<TemplateObject> {
    return this.http.request("PATCH", `/templates/${enc(slug)}`, {
      body: input,
    });
  }

  remove(slug: string): Promise<void> {
    return this.http.request("DELETE", `/templates/${enc(slug)}`);
  }

  /**
   * Renders without sending — byte-identical to what a send would store, so
   * this is a safe preview. Retried like a read: it changes nothing.
   *
   * Resolves with the rendered `subject`, `html` and `text` only; the
   * variables are deliberately not echoed back.
   */
  render(
    slug: string,
    variables: Record<string, unknown> = {},
  ): Promise<RenderedTemplateObject> {
    return this.http.request("POST", `/templates/${enc(slug)}/render`, {
      body: { variables },
      retry: true,
    });
  }
}
