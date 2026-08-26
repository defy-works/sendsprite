import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "@/lib/cloudflare/client";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.example.com";
  process.env.CLOUDFLARE_OAUTH_CLIENT_ID = "cid";
  process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET = "csecret";
});
afterAll(async () => {
  await pg.stop();
});

async function reset() {
  const { updateInstanceSettings } =
    await import("@/services/instance-settings");
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
  await updateInstanceSettings(
    {
      cloudflareAccessToken: null,
      cloudflareRefreshToken: null,
      cloudflareTokenExpiresAt: null,
      cloudflareConnectedAt: null,
      cloudflareAccountName: null,
    },
    undefined,
    { audit: false },
  );
}
/** Every test starts from a disconnected instance. */
beforeEach(reset);

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
  const res = beginOauth();
  if (!res.ok) throw new Error(res.error);
  const url = new URL(res.data.url);
  return {
    handoff: res.data.handoff,
    state: url.searchParams.get("state")!,
    url,
  };
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
    expect(beginOauth()).toMatchObject({ ok: false, code: "not_configured" });
    process.env.CLOUDFLARE_OAUTH_CLIENT_ID = "cid";
    resetEnvCache();
  });
});

describe("completeOauth", () => {
  it("exchanges the code, stores both tokens encrypted and lists zones", async () => {
    const { completeOauth, listZones } =
      await import("@/services/cloudflare-connect");
    const { getInstanceSettings, getDecryptedSecrets } =
      await import("@/services/instance-settings");
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

    const s = await getInstanceSettings();
    expect(s.cloudflareConnectedAt).toBeInstanceOf(Date);
    expect(s.cloudflareAccountName).toBe("acme.com");
    expect(s.cloudflareAccessTokenEnc).toMatch(/^v1\./);
    expect(s.cloudflareAccessTokenEnc).not.toContain("at-1");
    expect(await getDecryptedSecrets()).toMatchObject({
      cloudflareAccessToken: "at-1",
      cloudflareRefreshToken: "rt-1",
    });
    expect(await listZones(fetch)).toEqual(ZONES);
  });

  it("refuses a state that does not match the one it issued", async () => {
    const { completeOauth } = await import("@/services/cloudflare-connect");
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
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
    expect((await getInstanceSettings()).cloudflareConnectedAt).toBeNull();
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
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
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
    expect((await getInstanceSettings()).cloudflareConnectedAt).toBeNull();
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
  async function connect(f: FetchLike) {
    const { completeOauth } = await import("@/services/cloudflare-connect");
    const { handoff, state } = await begin();
    const res = await completeOauth({ code: "c1", state }, handoff, actor, f);
    if (!res.ok) throw new Error(res.error);
  }

  it("returns null when Cloudflare was never connected", async () => {
    const { cloudflareClient } = await import("@/services/cloudflare-connect");
    expect(await cloudflareClient(fake().fetch)).toBeNull();
  });

  it("refreshes an expired access token and stores the new one", async () => {
    const { cloudflareClient } = await import("@/services/cloudflare-connect");
    const { updateInstanceSettings, getDecryptedSecrets } =
      await import("@/services/instance-settings");
    const { fetch, calls } = fake();
    await connect(fetch);
    await updateInstanceSettings(
      { cloudflareTokenExpiresAt: new Date(Date.now() - 1000) },
      undefined,
      { audit: false },
    );
    calls.length = 0;

    expect(await cloudflareClient(fetch)).not.toBeNull();
    const refresh = calls.find((c) => c.url.includes("/oauth2/token"))!;
    expect(refresh.body).toContain("grant_type=refresh_token");
    expect(refresh.body).toContain("refresh_token=rt-1");
    expect((await getDecryptedSecrets()).cloudflareAccessToken).toBe("at-1");
  });

  it("keeps the old refresh token when Cloudflare does not rotate it", async () => {
    const { cloudflareClient } = await import("@/services/cloudflare-connect");
    const { updateInstanceSettings, getDecryptedSecrets } =
      await import("@/services/instance-settings");
    await connect(fake().fetch);
    await updateInstanceSettings(
      { cloudflareTokenExpiresAt: new Date(Date.now() - 1000) },
      undefined,
      { audit: false },
    );
    const { fetch } = fake({
      token: { access_token: "at-2", expires_in: 3600 },
    });
    expect(await cloudflareClient(fetch)).not.toBeNull();
    expect(await getDecryptedSecrets()).toMatchObject({
      cloudflareAccessToken: "at-2",
      cloudflareRefreshToken: "rt-1",
    });
  });

  it("disconnects itself when the refresh is rejected", async () => {
    const { cloudflareClient } = await import("@/services/cloudflare-connect");
    const { updateInstanceSettings, getInstanceSettings } =
      await import("@/services/instance-settings");
    await connect(fake().fetch);
    await updateInstanceSettings(
      { cloudflareTokenExpiresAt: new Date(Date.now() - 1000) },
      undefined,
      { audit: false },
    );
    const { fetch } = fake({
      tokenStatus: 400,
      token: { error: "invalid_grant" },
    });
    expect(await cloudflareClient(fetch)).toBeNull();
    const s = await getInstanceSettings();
    expect(s.cloudflareConnectedAt).toBeNull();
    expect(s.cloudflareRefreshTokenEnc).toBeNull();
  });
});

describe("disconnectCloudflare", () => {
  it("revokes the grant and clears every stored field", async () => {
    const { completeOauth, disconnectCloudflare, cloudflareClient } =
      await import("@/services/cloudflare-connect");
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
    const { handoff, state } = await begin();
    const { fetch, calls } = fake();
    await completeOauth({ code: "c1", state }, handoff, actor, fetch);
    calls.length = 0;

    expect(await disconnectCloudflare(actor, fetch)).toMatchObject({
      ok: true,
    });
    const revoke = calls.find((c) => c.url.includes("/oauth2/revoke"))!;
    expect(revoke.body).toContain("token=rt-1");

    const s = await getInstanceSettings();
    expect(s.cloudflareConnectedAt).toBeNull();
    expect(s.cloudflareAccessTokenEnc).toBeNull();
    expect(s.cloudflareRefreshTokenEnc).toBeNull();
    expect(s.cloudflareAccountName).toBeNull();
    expect(await cloudflareClient(fetch)).toBeNull();
  });
});
