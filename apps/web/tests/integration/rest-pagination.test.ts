import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
});
afterAll(async () => {
  await pg.stop();
});

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;
const noParams = { params: Promise.resolve({}) };
const get = (h: Handler, secret: string, qs = "") =>
  h(
    new Request(`http://x/api/v1/x${qs}`, {
      headers: { authorization: `Bearer ${secret}` },
    }),
    noParams,
  );
const post = (h: Handler, secret: string, body: unknown) =>
  h(
    new Request("http://x/api/v1/x", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    noParams,
  );

/** Walks `?limit=n&cursor=` until `nextCursor` is null; returns every id seen. */
async function walk(h: Handler, secret: string, limit: number) {
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const r = await get(
      h,
      secret,
      `?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      data: { id: string }[];
      nextCursor: string | null;
    };
    expect(body.data.length).toBeLessThanOrEqual(limit);
    seen.push(...body.data.map((k) => k.id));
    cursor = body.nextCursor;
  } while (cursor);
  return seen;
}

describe("cursor pagination", () => {
  it("api-keys: limit + nextCursor walk the whole set newest first, no repeats", async () => {
    const { GET: listKeys, POST: createKey } =
      await import("@/app/api/v1/api-keys/route");
    const { secret } = await seedTeamWithKey();
    for (let i = 0; i < 5; i++)
      expect((await post(createKey, secret, { name: `k${i}` })).status).toBe(
        201,
      );
    const seen = await walk(listKeys, secret, 2);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(6); // 5 + the seeded key
    const all = (await (await get(listKeys, secret, "?limit=100")).json()) as {
      data: { id: string; name: string }[];
    };
    expect(all.data.map((k) => k.id)).toEqual(seen);
    expect(all.data[0]!.name).toBe("k4");
  });

  it("suppressions: same envelope", async () => {
    const { GET: listSuppressions, POST: addSuppression } =
      await import("@/app/api/v1/suppressions/route");
    const { secret } = await seedTeamWithKey();
    for (const e of ["a@x.io", "b@x.io", "c@x.io"])
      await addSuppression(
        new Request("http://x", {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ email: e }),
        }),
        noParams,
      );
    const r = await get(listSuppressions, secret, "?limit=2");
    const body = (await r.json()) as {
      data: unknown[];
      nextCursor: string | null;
    };
    expect(body.data).toHaveLength(2);
    expect(typeof body.nextCursor).toBe("string");
    const r2 = await get(
      listSuppressions,
      secret,
      `?limit=2&cursor=${body.nextCursor}`,
    );
    const body2 = (await r2.json()) as {
      data: unknown[];
      nextCursor: string | null;
    };
    expect(body2.data).toHaveLength(1);
    expect(body2.nextCursor).toBeNull();
  });

  it("webhooks and domains: default page, envelope with nextCursor", async () => {
    const { GET: listWebhooks } = await import("@/app/api/v1/webhooks/route");
    const { GET: listDomains } = await import("@/app/api/v1/domains/route");
    const { secret } = await seedTeamWithKey();
    for (const h of [listWebhooks, listDomains]) {
      const r = await get(h, secret);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ data: [], nextCursor: null });
    }
  });

  it("keeps walking after the cursor row is deleted; garbage cursor is 400", async () => {
    const { GET: listKeys, POST: createKey } =
      await import("@/app/api/v1/api-keys/route");
    const { DELETE: revokeKey } =
      await import("@/app/api/v1/api-keys/[id]/route");
    const { secret } = await seedTeamWithKey();
    for (let i = 0; i < 4; i++)
      await post(createKey, secret, { name: `k${i}` });
    const p1 = (await (await get(listKeys, secret, "?limit=2")).json()) as {
      data: { id: string }[];
      nextCursor: string;
    };
    const lastOnPage = p1.data[1]!.id;
    const del = await revokeKey(
      new Request("http://x", {
        method: "DELETE",
        headers: { authorization: `Bearer ${secret}` },
      }),
      { params: Promise.resolve({ id: lastOnPage }) },
    );
    expect(del.status).toBe(204);
    // The cursor row is gone; the next page still starts right after it.
    const p2 = (await (
      await get(listKeys, secret, `?limit=2&cursor=${p1.nextCursor}`)
    ).json()) as { data: { id: string }[] };
    const p1Ids = p1.data.map((k) => k.id);
    expect(p2.data).toHaveLength(2);
    for (const k of p2.data) expect(p1Ids).not.toContain(k.id);

    const bad = await get(listKeys, secret, "?limit=2&cursor=garbage");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: { code: "validation_error", message: "Invalid cursor." },
    });
  });

  it("rejects a bad limit", async () => {
    const { GET: listKeys } = await import("@/app/api/v1/api-keys/route");
    const { secret } = await seedTeamWithKey();
    expect((await get(listKeys, secret, "?limit=0")).status).toBe(400);
    expect((await get(listKeys, secret, "?limit=101")).status).toBe(400);
  });
});
