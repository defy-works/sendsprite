import type { HttpClient } from "../client";
import type {
  AudiencePreview,
  CampaignObject,
  CreateCampaignInput,
  ListCampaignsParams,
  Page,
  ScheduleCampaignInput,
  UpdateCampaignInput,
} from "../types";
import { enc } from "./emails";

/**
 * Bulk mail to a contact book. Every method needs a `full` key — a
 * `sending_only` key may post one transactional email but not mail a whole
 * list, and the server refuses these routes for it.
 *
 * The lifecycle is `draft` → `scheduled` → `sending` → `sent`, and only the
 * first two are editable. There are two ways out of `draft` and they are
 * deliberately separate calls: `schedule()` takes a time, `sendNow()` does
 * not take one and says so in its name. `cancel()` is the only way back.
 */
export class Campaigns {
  constructor(private readonly http: HttpClient) {}

  list(params: ListCampaignsParams = {}): Promise<Page<CampaignObject>> {
    return this.http.request("GET", "/campaigns", {
      query: {
        limit: params.limit,
        cursor: params.cursor,
        status: params.status,
      },
    });
  }

  /** Walks every page of `list()` starting from the first. */
  async *iterate(
    params: Omit<ListCampaignsParams, "cursor"> = {},
  ): AsyncGenerator<CampaignObject, void, undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...params, cursor });
      yield* page.data;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  get(id: string): Promise<CampaignObject> {
    return this.http.request("GET", `/campaigns/${enc(id)}`);
  }

  /** Creates a `draft`. Nothing about this call sends anything. */
  create(input: CreateCampaignInput): Promise<CampaignObject> {
    return this.http.request("POST", "/campaigns", { body: input });
  }

  /** Partial update; refused once the campaign is past `scheduled`. */
  update(id: string, input: UpdateCampaignInput): Promise<CampaignObject> {
    return this.http.request("PATCH", `/campaigns/${enc(id)}`, { body: input });
  }

  /** Refused while a campaign is `sending`; `cancel()` it first. */
  remove(id: string): Promise<void> {
    return this.http.request("DELETE", `/campaigns/${enc(id)}`);
  }

  /**
   * Queues the send for `at` and moves the campaign to `scheduled`. A `Date`
   * is sent as its ISO instant; a string must already carry an offset.
   *
   * The time is required even though the endpoint would take an empty body
   * and start immediately. A method that mails everyone on the book when you
   * forget its second argument is the wrong shape for an irreversible action,
   * so the immediate send is `sendNow()` — a name you cannot type by
   * accident — and `schedule(id)` does not compile.
   */
  schedule(id: string, at: Date | string): Promise<CampaignObject> {
    const body: ScheduleCampaignInput = {
      scheduledAt: at instanceof Date ? at.toISOString() : at,
    };
    return this.http.request("POST", `/campaigns/${enc(id)}/schedule`, {
      body,
    });
  }

  /**
   * Starts the fan-out now, to every eligible contact in the book.
   *
   * Irreversible for everyone it reaches: `cancel()` stops the batches that
   * have not gone out, never the mail already handed to the provider. Read
   * `audience().eligible` first — that is the number this will mail.
   *
   * Not retried. A resend after a timeout would be a second campaign to the
   * same list, which is worse than an error you can act on.
   */
  sendNow(id: string): Promise<CampaignObject> {
    const body: ScheduleCampaignInput = {};
    return this.http.request("POST", `/campaigns/${enc(id)}/schedule`, {
      body,
    });
  }

  /**
   * `scheduled` → `draft`, or `sending` → `cancelled`. Safe to retry: a
   * campaign that is already stopped stays stopped.
   */
  cancel(id: string): Promise<CampaignObject> {
    return this.http.request("POST", `/campaigns/${enc(id)}/cancel`, {
      retry: true,
    });
  }

  /** Who a send would reach right now. See `AudiencePreview`. */
  audience(id: string): Promise<AudiencePreview> {
    return this.http.request("GET", `/campaigns/${enc(id)}/audience`);
  }
}
