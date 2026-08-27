import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "@/lib/cloudflare/client";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
let TEAM: string;
let OTHER: string;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.example.com";
  process.env.CLOUDFLARE_OAUTH_CLIENT_ID = "cid";
  process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET = "csecret";
  TEAM = (await seedTeamWithKey()).team.id;
  OTHER = (await seedTeamWithKey()).team.id;
});
afterAll(async () => {
  await pg.stop();
});

async function reset() {
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
  const { teamCloudflare } = await import("@/db/schema");
  await pg.db.delete(teamCloudflare);
}
/** Every test starts from a disconnected team. */
beforeEach(reset);

/** The team's grant row straight from the database, past React.cache. */
async function grant(teamId = TEAM) {
  const { teamCloudflare } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await pg.db
    .select()
    .from(teamCloudflare)
    .where(eq(teamCloudflare.teamId, teamId));
  return row ?? null;
}
/** Push the stored access token past its expiry so the next read refreshes. */
async function expireToken(teamId = TEAM) {
  const { teamCloudflare } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  await pg.db
    .update(teamCloudflare)
    .set({ tokenExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(teamCloudflare.teamId, teamId));
}

/** Decrypted tokens for a team, or null when it has no grant. */
async function tokens(teamId = TEAM) {
  const row = await grant(teamId);
  if (!row) return null;
  const { getCipher } = await import("@/lib/crypto");
  const c = getCipher();
  return {
    accessToken: c.decrypt(row.accessTokenEnc),
    refreshToken: row.refreshTokenEnc ? c.decrypt(row.refreshTokenEnc) : null,
  };
}

const ZONES = [{ id: "z1", name: "acme.com" }];

interface FakeOpts {
  token?: object;
  tokenStatus?: number;
  zones?: { id: string; name: string }[];
}
/** Cloudflare's token endpoint plus the v4 API, with the calls it saw. */
function fake({ token, tokenStatus = 200, zones = ZONES }: FakeOpts = {}) {
  const calls: { url: string; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body as string | undefined });
    if (u.includes("/oauth2/token"))
      return new Response(
        JSON.stringify(
          token ?? {
            access_token: "at-1",
            refresh_token: "rt-1",
            expires_in: 3600,
          },
        ),
        { status: tokenStatus },
      );
    if (u.includes("/oauth2/revoke")) return new Response("{}");
    if (u.includes("/zones"))
      return new Response(JSON.stringify({ success: true, result: zones }));
    return new Response("{}", { status: 404 });
  };
  return { fetch, calls };
}

const actor = { userId: "u1" };

/** Runs `beginOauth` and returns the pieces a browser would carry back. */
async function begin() {
  const { beginOauth } = await import("@/services/cloudflare-connect");
  const res = beginOauth(TEAM);
  if (!res.ok) throw new Error(res.error);
  const url = new URL(res.data.url);
  return {
    handoff: res.data.handoff,
    state: url.searchParams.get("state")!,
    url,
  };
}

/** Take TEAM through a full consent round-trip against the fake Cloudflare. */
async function connect(f: FetchLike) {
  const { completeOauth } = await import("@/services/cloudflare-connect");
  const { handoff, state } = await begin();
  const res = await completeOauth({ code: "c1", state }, handoff, actor, f);
  if (!res.ok) throw new Error(res.error);
}

describe("beginOauth", () => {
  it("builds a PKCE consent URL for the configured client", async () => {
    const { url } = await begin();
    expect(url.origin + url.pathname).toBe(
      "https://dash.cloudflare.com/oauth2/auth",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "cid",
      redirect_uri: "https://mail.example.com/api/setup/cloudflare/callback",
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });

  it("refuses when no OAuth client is configured", async () => {
    delete process.env.CLOUDFLARE_OAUTH_CLIENT_ID;
    const { resetEnvCache } = await import("@/env.schema");
    resetEnvCache();
    const { beginOauth, oauthAvailable } =
      await import("@/services/cloudflare-connect");
    expect(oauthAvailable()).toBe(false);
    expect(beginOauth(TEAM)).toMatchObject({
      ok: false,
      code: "not_configured",
    });
    process.env.CLOUDFLARE_OAUTH_CLIENT_ID = "cid";
    resetEnvCache();
  });
});

describe("completeOauth", () => {
  it("exchanges the code, stores both tokens encrypted and lists zones", async () => {
    const { completeOauth, listZones } =
      await import("@/services/cloudflare-connect");
    const { handoff, state } = await begin();
    const { fetch, calls } = fake();

    const res = await completeOauth(
      { code: "c1", state },
      handoff,
      actor,
      fetch,
    );
    expect(res).toMatchObject({ ok: true, data: { zones: ZONES } });

    const exchange = calls.find((c) => c.url.includes("/oauth2/token"))!;
    expect(exchange.body).toContain("grant_type=authorization_code");
    expect(exchange.body).toContain("code_verifier=");

    const row = await grant();
    expect(row?.connectedAt).toBeInstanceOf(Date);
    expect(row?.accountName).toBe("acme.com");
    expect(row?.accessTokenEnc).toMatch(/^v1\./);
    expect(row?.accessTokenEnc).not.toContain("at-1");
    expect(await tokens()).toMatchObject({
      accessToken: "at-1",
      refreshToken: "rt-1",
    });
    expect(await listZones(TEAM, fetch)).toEqual(ZONES);
  });

  it("refuses a state that does not match the one it issued", async () => {
    const { completeOauth } = await import("@/services/cloudflare-connect");
    const { handoff } = await begin();
    const { fetch, calls } = fake();

    const res = await completeOauth(
      { code: "c1", state: "not-the-state" },
      handoff,
      actor,
      fetch,
    );
    expect(res).toMatchObject({ ok: false, code: "bad_state" });
    // Nothing is sent to Cloudflare when the state fails.
    expect(calls).toHaveLength(0);
    expect(await grant()).toBeNull();
  });

  it("refuses a missing or unparseable handoff", async () => {
    const { completeOauth } = await import("@/services/cloudflare-connect");
    const { fetch } = fake();
    expect(
      await completeOauth({ code: "c1", state: "s" }, undefined, actor, fetch),
    ).toMatchObject({ ok: false, code: "expired" });
  });

  it("surfaces a rejection from the token endpoint", async () => {
    const { completeOauth } = await import("@/services/cloudflare-connect");
    const { handoff, state } = await begin();
    const { fetch } = fake({
      tokenStatus: 400,
      token: {
        error: "invalid_grant",
        error_description: "authorization code expired",
      },
    });
    const res = await completeOauth(
      { code: "c1", state },
      handoff,
      actor,
      fetch,
    );
    expect(res).toMatchObject({ ok: false, code: "invalid_grant" });
    expect(res.ok === false && res.error).toMatch(/authorization code expired/);
    expect(await grant()).toBeNull();
  });

  it("connects with a warning when the grant covers no zones", async () => {
    const { completeOauth } = await import("@/services/cloudflare-connect");
    const { handoff, state } = await begin();
    const { fetch } = fake({ zones: [] });
    const res = await completeOauth(
      { code: "c1", state },
      handoff,
      actor,
      fetch,
    );
    expect(res.ok && res.data.warning).toMatch(/no zones/i);
  });
});

describe("cloudflareClient", () => {
  it("returns null when Cloudflare was never connected", async () => {
    const { cloudflareClient } = await import("@/services/cloudflare-connect");
    expect(await cloudflareClient(TEAM, fake().fetch)).toBeNull();
  });

  it("refreshes an expired access token and stores the new one", async () => {
    const { cloudflareClient } = await import("@/services/cloudflare-connect");
    const { fetch, calls } = fake();
    await connect(fetch);
    await expireToken();
    calls.length = 0;

    expect(await cloudflareClient(TEAM, fetch)).not.toBeNull();
    const refresh = calls.find((c) => c.url.includes("/oauth2/token"))!;
    expect(refresh.body).toContain("grant_type=refresh_token");
    expect(refresh.body).toContain("refresh_token=rt-1");
    expect((await tokens())?.accessToken).toBe("at-1");
  });

  it("keeps the old refresh token when Cloudflare does not rotate it", async () => {
    const { cloudflareClient } = await import("@/services/cloudflare-connect");
    await connect(fake().fetch);
    await expireToken();
    const { fetch } = fake({
      token: { access_token: "at-2", expires_in: 3600 },
    });
    expect(await cloudflareClient(TEAM, fetch)).not.toBeNull();
    expect(await tokens()).toMatchObject({
      accessToken: "at-2",
      refreshToken: "rt-1",
    });
  });

  it("disconnects itself when the refresh is rejected", async () => {
    const { cloudflareClient } = await import("@/services/cloudflare-connect");
    await connect(fake().fetch);
    await expireToken();
    const { fetch } = fake({
      tokenStatus: 400,
      token: { error: "invalid_grant" },
    });
    expect(await cloudflareClient(TEAM, fetch)).toBeNull();
    // A rejected refresh deletes the row so the UI shows "not connected".
    expect(await grant()).toBeNull();
  });
});

describe("disconnectCloudflare", () => {
  it("revokes the grant and clears every stored field", async () => {
    const { completeOauth, disconnectCloudflare, cloudflareClient } =
      await import("@/services/cloudflare-connect");
    const { handoff, state } = await begin();
    const { fetch, calls } = fake();
    await completeOauth({ code: "c1", state }, handoff, actor, fetch);
    calls.length = 0;

    expect(await disconnectCloudflare(TEAM, actor, fetch)).toMatchObject({
      ok: true,
    });
    const revoke = calls.find((c) => c.url.includes("/oauth2/revoke"))!;
    expect(revoke.body).toContain("token=rt-1");

    // Disconnecting deletes the row; there is no half-cleared grant.
    expect(await grant()).toBeNull();
    expect(await cloudflareClient(TEAM, fetch)).toBeNull();
  });
});

describe("team scoping", () => {
  it("keeps one team's grant invisible to another", async () => {
    const { getTeamCloudflare } = await import("@/services/cloudflare-connect");
    await connect(fake().fetch);
    expect(await grant(TEAM)).not.toBeNull();
    expect(await getTeamCloudflare(OTHER)).toBeNull();
  });

  it("binds the grant to the team that started the flow, not the caller", async () => {
    const { beginOauth, completeOauth } =
      await import("@/services/cloudflare-connect");
    const started = beginOauth(OTHER);
    if (!started.ok) throw new Error(started.error);
    const state = new URL(started.data.url).searchParams.get("state")!;
    const { fetch } = fake();
    const res = await completeOauth(
      { code: "c1", state },
      started.data.handoff,
      actor,
      fetch,
    );
    expect(res).toMatchObject({ ok: true, data: { teamId: OTHER } });
    expect(await grant(OTHER)).not.toBeNull();
    expect(await grant(TEAM)).toBeNull();
  });

  it("refuses a handoff carrying no team", async () => {
    const { completeOauth } = await import("@/services/cloudflare-connect");
    const { state } = await begin();
    const res = await completeOauth(
      { code: "c1", state },
      JSON.stringify({ state, verifier: "v" }),
      actor,
      fake().fetch,
    );
    expect(res).toMatchObject({ ok: false, code: "bad_state" });
  });

  it("disconnect deletes only the calling team's row", async () => {
    const { beginOauth, completeOauth, disconnectCloudflare } =
      await import("@/services/cloudflare-connect");
    const { fetch } = fake();
    await connect(fetch);
    const other = beginOauth(OTHER);
    if (!other.ok) throw new Error(other.error);
    const otherState = new URL(other.data.url).searchParams.get("state")!;
    await completeOauth(
      { code: "c2", state: otherState },
      other.data.handoff,
      actor,
      fetch,
    );

    await disconnectCloudflare(TEAM, actor, fetch);
    expect(await grant(TEAM)).toBeNull();
    expect(await grant(OTHER)).not.toBeNull();
  });
});
