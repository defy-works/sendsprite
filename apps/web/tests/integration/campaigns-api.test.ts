import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

const BASE = "http://localhost/api/v1/campaigns";
const req = (method: string, url = BASE, key?: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: {
      ...(key && { authorization: `Bearer ${key}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const noParams = { params: Promise.resolve({}) };
const withId = (id: string) => ({ params: Promise.resolve({ id }) });

const routes = () =>
  Promise.all([
    import("@/app/api/v1/campaigns/route"),
    import("@/app/api/v1/campaigns/[id]/route"),
    import("@/app/api/v1/campaigns/[id]/schedule/route"),
    import("@/app/api/v1/campaigns/[id]/cancel/route"),
    import("@/app/api/v1/campaigns/[id]/audience/route"),
  ]).then(([list, one, schedule, cancel, audience]) => ({
    list,
    one,
    schedule,
    cancel,
    audience,
  }));

/**
 * A team with a `full` key, a verified sending domain, a contact book and a
 * draft body ready to POST. Every id is suffixed per call so two teams can
 * exist side by side in one file.
 */
async function seedTeam() {
  const { db } = await import("@/db");
  const { contactBooks, domains } = await import("@/db/schema");
  const { secret, team, actor } = await seedTeamWithKey();
  const suffix = randomBytes(4).toString("hex");
  const domainName = `${suffix}.example.test`;
  const domainId = `dom_${suffix}`;
  const bookId = `cb_${suffix}`;
  await db()
    .insert(domains)
    .values({
      id: domainId,
      teamId: team.id,
      name: domainName,
      region: "eu-west-1",
      dnsMode: "manual",
      status: "verified",
      mailFromDomain: `bounce.${domainName}`,
    });
  await db()
    .insert(contactBooks)
    .values({ id: bookId, teamId: team.id, name: "News" });
  return {
    secret,
    team,
    actor,
    bookId,
    domainId,
    draft: {
      name: "August news",
      bookId,
      domainId,
      from: `news@${domainName}`,
      subject: "Hello",
      blocks: [{ kind: "text", html: "Hi" }],
    },
  };
}

/** Seeds a team and POSTs one draft through the route, returning its id. */
async function createCampaign() {
  const seed = await seedTeam();
  const { list } = await routes();
  const res = await list.POST(
    req("POST", BASE, seed.secret, seed.draft),
    noParams,
  );
  if (res.status !== 201)
    throw new Error(`seed create failed: ${JSON.stringify(await res.json())}`);
  const body = (await res.json()) as { id: string };
  return { ...seed, id: body.id };
}

/** Drops a campaign into a status no route will create it in. */
async function forceStatus(id: string, status: string) {
  const { db } = await import("@/db");
  const { campaigns } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  await db()
    .update(campaigns)
    .set({ status: status as "sending" })
    .where(eq(campaigns.id, id));
}

describe("REST /api/v1/campaigns", () => {
  /*
   * The blast-radius test, and the reason it is table-driven over *every*
   * route rather than asserted once: a `sending_only` key exists to be
   * deployed where a `full` key should not go — an app server that sends
   * password resets. One campaigns route left open to it is one `POST` away
   * from mailing a customer's entire contact book. A check that covers only
   * the first endpoint is exactly the check that rots as endpoints are added,
   * so the table is the point.
   */
  it("refuses a sending-only key on every campaign route, and no key at all", async () => {
    const { list, one, schedule, cancel, audience } = await routes();
    const { secret: sendingOnly } = await seedTeamWithKey({
      permission: "sending_only",
    });
    const { id } = await createCampaign();
    const calls: [string, () => Promise<Response>][] = [
      [
        "GET /campaigns",
        () => list.GET(req("GET", BASE, sendingOnly), noParams),
      ],
      [
        "POST /campaigns",
        () => list.POST(req("POST", BASE, sendingOnly, {}), noParams),
      ],
      [
        "GET /campaigns/:id",
        () => one.GET(req("GET", BASE, sendingOnly), withId(id)),
      ],
      [
        "PATCH /campaigns/:id",
        () =>
          one.PATCH(req("PATCH", BASE, sendingOnly, { name: "x" }), withId(id)),
      ],
      [
        "DELETE /campaigns/:id",
        () => one.DELETE(req("DELETE", BASE, sendingOnly), withId(id)),
      ],
      [
        "POST /campaigns/:id/schedule",
        () => schedule.POST(req("POST", BASE, sendingOnly, {}), withId(id)),
      ],
      [
        "POST /campaigns/:id/cancel",
        () => cancel.POST(req("POST", BASE, sendingOnly), withId(id)),
      ],
      [
        "GET /campaigns/:id/audience",
        () => audience.GET(req("GET", BASE, sendingOnly), withId(id)),
      ],
    ];
    expect(calls).toHaveLength(8);
    for (const [name, call] of calls) {
      const res = await call();
      expect(res.status, name).toBe(403);
      expect(await res.json(), name).toMatchObject({
        error: { code: "forbidden" },
      });
    }
    // And the campaign is untouched by all of that.
    const { secret } = await seedTeamWithKey();
    expect(
      (await one.GET(req("GET", BASE, secret), withId(id))).status,
      "another team's key",
    ).toBe(404);

    // No key at all is a 401 on the same eight.
    for (const [name, res] of [
      ["GET /campaigns", await list.GET(req("GET"), noParams)],
      [
        "POST /campaigns",
        await list.POST(req("POST", BASE, undefined, {}), noParams),
      ],
      ["GET /campaigns/:id", await one.GET(req("GET"), withId(id))],
      [
        "PATCH /campaigns/:id",
        await one.PATCH(req("PATCH", BASE, undefined, {}), withId(id)),
      ],
      ["DELETE /campaigns/:id", await one.DELETE(req("DELETE"), withId(id))],
      [
        "POST /campaigns/:id/schedule",
        await schedule.POST(req("POST"), withId(id)),
      ],
      [
        "POST /campaigns/:id/cancel",
        await cancel.POST(req("POST"), withId(id)),
      ],
      [
        "GET /campaigns/:id/audience",
        await audience.GET(req("GET"), withId(id)),
      ],
    ] as [string, Response][])
      expect(res.status, name).toBe(401);
  });

  it("creates (201), lists, reads, patches and deletes (204)", async () => {
    const { list, one } = await routes();
    const seed = await seedTeam();
    const created = await list.POST(
      req("POST", BASE, seed.secret, seed.draft),
      noParams,
    );
    expect(created.status).toBe(201);
    const campaign = (await created.json()) as { id: string; status: string };
    expect(campaign.id).toMatch(/^cmp_/);
    expect(campaign).toMatchObject({
      status: "draft",
      name: "August news",
      bookId: seed.bookId,
      domainId: seed.domainId,
      subject: "Hello",
      scheduledAt: null,
      sentAt: null,
      counts: { recipients: 0, sent: 0 },
    });
    // `publicCampaign` returns `Date`s; the envelope serialises them to the
    // ISO strings `CampaignObject` declares.
    expect(
      typeof (campaign as unknown as { createdAt: string }).createdAt,
    ).toBe("string");
    // Rendered artefacts and tenancy never leave the service.
    expect(campaign).not.toHaveProperty("html");
    expect(campaign).not.toHaveProperty("teamId");
    expect(campaign).not.toHaveProperty("fanoutCursor");

    const page = await list.GET(req("GET", BASE, seed.secret), noParams);
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      data: [{ id: campaign.id }],
      nextCursor: null,
    });

    const read = await one.GET(
      req("GET", BASE, seed.secret),
      withId(campaign.id),
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: campaign.id });

    const patched = await one.PATCH(
      req("PATCH", BASE, seed.secret, { subject: "Hello again" }),
      withId(campaign.id),
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ subject: "Hello again" });

    const deleted = await one.DELETE(
      req("DELETE", BASE, seed.secret),
      withId(campaign.id),
    );
    expect(deleted.status).toBe(204);
    expect(
      (await one.GET(req("GET", BASE, seed.secret), withId(campaign.id)))
        .status,
    ).toBe(404);
  });

  it("filters the list by status and rejects a status that is not one", async () => {
    const { list, schedule } = await routes();
    const seed = await createCampaign();
    const second = await list.POST(
      req("POST", BASE, seed.secret, { ...seed.draft, name: "Second" }),
      noParams,
    );
    const other = (await second.json()) as { id: string };
    await schedule.POST(
      req("POST", BASE, seed.secret, {
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      withId(other.id),
    );
    const drafts = await list.GET(
      req("GET", `${BASE}?status=draft`, seed.secret),
      noParams,
    );
    expect(
      ((await drafts.json()) as { data: { id: string }[] }).data.map(
        (c) => c.id,
      ),
    ).toEqual([seed.id]);
    const scheduled = await list.GET(
      req("GET", `${BASE}?status=scheduled`, seed.secret),
      noParams,
    );
    expect(
      ((await scheduled.json()) as { data: { id: string }[] }).data.map(
        (c) => c.id,
      ),
    ).toEqual([other.id]);
    // A typo is a refusal naming the field, not a silently empty page that
    // reads as "you have no drafts".
    const bad = await list.GET(
      req("GET", `${BASE}?status=drft`, seed.secret),
      noParams,
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("400s a create with no body, a bad block or an unsafe URL", async () => {
    const { list } = await routes();
    const seed = await seedTeam();
    expect(
      (await list.POST(req("POST", BASE, seed.secret), noParams)).status,
    ).toBe(400);
    expect(
      (
        await list.POST(
          req("POST", BASE, seed.secret, { ...seed.draft, blocks: [] }),
          noParams,
        )
      ).status,
    ).toBe(400);
    const unsafe = await list.POST(
      req("POST", BASE, seed.secret, {
        ...seed.draft,
        blocks: [{ kind: "button", label: "Go", url: "javascript:alert(1)" }],
      }),
      noParams,
    );
    expect(unsafe.status).toBe(400);
  });

  it("422s a create against an unverified domain, naming the field", async () => {
    const { db } = await import("@/db");
    const { domains } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { list } = await routes();
    const seed = await seedTeam();
    await db()
      .update(domains)
      .set({ status: "failed" })
      .where(eq(domains.id, seed.domainId));
    const res = await list.POST(
      req("POST", BASE, seed.secret, seed.draft),
      noParams,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { code: "domain_not_verified", details: { field: "domainId" } },
    });
  });

  it("404s a read, patch, delete, schedule, cancel or audience of a campaign that is not there", async () => {
    const { one, schedule, cancel, audience } = await routes();
    const { secret } = await seedTeam();
    const ghost = "cmp_00000000000000000000000000";
    for (const res of [
      await one.GET(req("GET", BASE, secret), withId(ghost)),
      await one.PATCH(req("PATCH", BASE, secret, { name: "x" }), withId(ghost)),
      await one.DELETE(req("DELETE", BASE, secret), withId(ghost)),
      await schedule.POST(req("POST", BASE, secret, {}), withId(ghost)),
      await cancel.POST(req("POST", BASE, secret), withId(ghost)),
      await audience.GET(req("GET", BASE, secret), withId(ghost)),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("409s a patch of a sending campaign and a delete of one", async () => {
    const { one } = await routes();
    const seed = await createCampaign();
    await forceStatus(seed.id, "sending");
    const patched = await one.PATCH(
      req("PATCH", BASE, seed.secret, { subject: "Changed" }),
      withId(seed.id),
    );
    expect(patched.status).toBe(409);
    expect(await patched.json()).toMatchObject({ error: { code: "conflict" } });
    const deleted = await one.DELETE(
      req("DELETE", BASE, seed.secret),
      withId(seed.id),
    );
    expect(deleted.status).toBe(409);
  });

  it("schedules for a future time and returns the armed campaign", async () => {
    const { schedule } = await routes();
    const seed = await createCampaign();
    const when = new Date(Date.now() + 3_600_000);
    const res = await schedule.POST(
      req("POST", BASE, seed.secret, { scheduledAt: when.toISOString() }),
      withId(seed.id),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: seed.id,
      status: "scheduled",
      scheduledAt: when.toISOString(),
    });
  });

  /*
   * An empty body is the "start now" request, so it must not be confused with
   * a malformed one — and the result is still `scheduled`, never `sending`:
   * `campaign.start-sweep` is the only thing that starts a send.
   */
  it("treats no body as start-now, and still leaves the campaign scheduled", async () => {
    const { schedule } = await routes();
    const seed = await createCampaign();
    const res = await schedule.POST(
      new Request(BASE, {
        method: "POST",
        headers: { authorization: `Bearer ${seed.secret}` },
      }),
      withId(seed.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      scheduledAt: string | null;
    };
    expect(body.status).toBe("scheduled");
    expect(body.scheduledAt).not.toBeNull();
    expect(new Date(body.scheduledAt!).getTime()).toBeLessThanOrEqual(
      Date.now() + 1000,
    );
  });

  it("400s a schedule whose body is not JSON", async () => {
    const { schedule } = await routes();
    const seed = await createCampaign();
    const res = await schedule.POST(
      new Request(BASE, {
        method: "POST",
        headers: {
          authorization: `Bearer ${seed.secret}`,
          "content-type": "application/json",
        },
        body: "{not json",
      }),
      withId(seed.id),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("400s a schedule for a time in the past and leaves the campaign a draft", async () => {
    const { schedule, one } = await routes();
    const seed = await createCampaign();
    const res = await schedule.POST(
      req("POST", BASE, seed.secret, {
        scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      withId(seed.id),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: { field: "scheduledAt" },
      },
    });
    const after = await one.GET(req("GET", BASE, seed.secret), withId(seed.id));
    expect(await after.json()).toMatchObject({
      status: "draft",
      scheduledAt: null,
    });
  });

  it("409s a schedule of a campaign that is already sending", async () => {
    const { schedule } = await routes();
    const seed = await createCampaign();
    await forceStatus(seed.id, "sending");
    const res = await schedule.POST(
      req("POST", BASE, seed.secret, {}),
      withId(seed.id),
    );
    expect(res.status).toBe(409);
  });

  it("cancels a scheduled campaign back to an editable draft", async () => {
    const { schedule, cancel, one } = await routes();
    const seed = await createCampaign();
    await schedule.POST(
      req("POST", BASE, seed.secret, {
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      withId(seed.id),
    );
    const res = await cancel.POST(
      req("POST", BASE, seed.secret),
      withId(seed.id),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "draft",
      scheduledAt: null,
    });
    // Un-armed means editable again.
    expect(
      (
        await one.PATCH(
          req("PATCH", BASE, seed.secret, { name: "Reviewed" }),
          withId(seed.id),
        )
      ).status,
    ).toBe(200);
  });

  /*
   * Cancelling a `sending` campaign stops further fan-out and nothing more.
   * Mail already handed to SES cannot be recalled, so the counts come back
   * exactly as they stood: a response that zeroed them would tell the
   * operator nothing had been sent, which is the one thing that is not true.
   */
  it("cancel on a sending campaign stops further fan-out without erasing what went out", async () => {
    const { db } = await import("@/db");
    const { campaigns } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { cancel } = await routes();
    const seed = await createCampaign();
    const counts = {
      recipients: 500,
      sent: 120,
      delivered: 110,
      opened: 30,
      clicked: 4,
      unsubscribed: 1,
      bounced: 2,
      complained: 0,
      failed: 1,
    };
    await db()
      .update(campaigns)
      .set({ status: "sending", startedAt: new Date(), counts })
      .where(eq(campaigns.id, seed.id));
    const res = await cancel.POST(
      req("POST", BASE, seed.secret),
      withId(seed.id),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "cancelled",
      counts,
      sentAt: null,
    });
    // The fan-out sweep only ever selects `sending`, so this is what stops it.
    const [row] = await db()
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, seed.id));
    expect(row!.status).toBe("cancelled");
  });

  it("409s a cancel of a draft and of an already cancelled campaign", async () => {
    const { cancel } = await routes();
    const seed = await createCampaign();
    const first = await cancel.POST(
      req("POST", BASE, seed.secret),
      withId(seed.id),
    );
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ error: { code: "conflict" } });
    await forceStatus(seed.id, "cancelled");
    expect(
      (await cancel.POST(req("POST", BASE, seed.secret), withId(seed.id)))
        .status,
    ).toBe(409);
  });

  it("previews the audience, counting consent and suppression together", async () => {
    const { db } = await import("@/db");
    const { contacts, suppressions } = await import("@/db/schema");
    const { audience } = await routes();
    const seed = await createCampaign();
    const contact = (n: number, subscribed: boolean) => ({
      id: `con_${randomBytes(6).toString("hex")}`,
      teamId: seed.team.id,
      bookId: seed.bookId,
      email: `c${n}-${randomBytes(3).toString("hex")}@example.test`,
      subscribed,
    });
    const rows = [
      contact(1, true),
      contact(2, true),
      contact(3, false),
      contact(4, true),
    ];
    await db().insert(contacts).values(rows);
    // Suppressed with a different case than the contact carries: the match is
    // on `lower(btrim(...))`, and a case-only miss would mail a suppressed
    // address in campaign volume.
    await db()
      .insert(suppressions)
      .values({
        id: `sup_${randomBytes(6).toString("hex")}`,
        teamId: seed.team.id,
        email: rows[3]!.email.toUpperCase(),
        reason: "bounce",
      });
    const res = await audience.GET(
      req("GET", BASE, seed.secret),
      withId(seed.id),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      contacts: 4,
      subscribed: 3,
      suppressed: 1,
      // Subscribed AND not suppressed: contacts 1 and 2.
      eligible: 2,
    });
  });

  it("answers four zeros for a campaign whose book was deleted", async () => {
    const { db } = await import("@/db");
    const { contactBooks } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { audience } = await routes();
    const seed = await createCampaign();
    await db().delete(contactBooks).where(eq(contactBooks.id, seed.bookId));
    const res = await audience.GET(
      req("GET", BASE, seed.secret),
      withId(seed.id),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      contacts: 0,
      subscribed: 0,
      suppressed: 0,
      eligible: 0,
    });
  });
});
