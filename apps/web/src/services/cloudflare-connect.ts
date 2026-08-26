import {
  CloudflareClient,
  CloudflareError,
  type CfZone,
  type FetchLike,
} from "@/lib/cloudflare/client";
import {
  authorizeUrl,
  exchangeCode,
  isExpired,
  newState,
  pkce,
  refreshTokens,
  revoke,
  statesMatch,
  CloudflareOauthError,
  type OauthClient,
  type TokenSet,
} from "@/lib/cloudflare/oauth";
import { loadEnv } from "@/env.schema";
import type { Result } from "@/lib/result";
import {
  getInstanceSettings,
  getDecryptedSecrets,
  updateInstanceSettings,
  type InstanceActor,
} from "./instance-settings";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Zero zones is not a failure, but the user should hear about it. */
const NO_ZONES =
  "Cloudflare is connected but the grant covers no zones — re-authorise and tick the zones you send from.";

/** Where Cloudflare sends the browser back. Must match the client's registered URI exactly. */
export const redirectPath = "/api/setup/cloudflare/callback";

/**
 * The configured OAuth client, or null when this instance has none. Null is
 * the self-hosted default and is not an error: domains fall back to the
 * manual record list plus a dashboard deep link.
 */
export function oauthClient(): OauthClient | null {
  const env = loadEnv();
  if (!env.CLOUDFLARE_OAUTH_CLIENT_ID || !env.CLOUDFLARE_OAUTH_CLIENT_SECRET)
    return null;
  return {
    clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID,
    clientSecret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
    redirectUri: new URL(redirectPath, env.APP_URL).toString(),
    scopes: env.CLOUDFLARE_OAUTH_SCOPES,
  };
}

export const oauthAvailable = () => oauthClient() !== null;

export interface OauthStart {
  url: string;
  /** Opaque, encrypted; the caller parks it in a short-lived cookie. */
  handoff: string;
}

/**
 * Step 1: build the consent URL. The `state` and the PKCE verifier travel
 * back to us in a cookie rather than the database — they are single-use,
 * expire in minutes, and belong to one browser, so a row would be pure
 * bookkeeping. Encrypted with the instance cipher so the verifier is not
 * readable even if the cookie leaks.
 */
export function beginOauth(): Result<OauthStart> {
  const c = oauthClient();
  if (!c)
    return {
      ok: false,
      code: "not_configured",
      error: "This instance has no Cloudflare OAuth client configured.",
    };
  const state = newState();
  const { verifier, challenge } = pkce();
  return {
    ok: true,
    data: {
      url: authorizeUrl(c, state, challenge),
      handoff: JSON.stringify({ state, verifier }),
    },
  };
}

/**
 * Step 2: verify `state`, trade the code for tokens, store them and read
 * back the zones the grant covers. `handoff` is the cookie payload from
 * `beginOauth`; a mismatch means the callback did not originate from a
 * consent flow this browser started, so it is refused without a call out.
 */
export async function completeOauth(
  params: { code: string; state: string },
  handoff: string | undefined,
  actor: InstanceActor,
  f: FetchLike = fetch,
): Promise<Result<{ zones: CfZone[]; warning?: string }>> {
  const c = oauthClient();
  if (!c)
    return {
      ok: false,
      code: "not_configured",
      error: "This instance has no Cloudflare OAuth client configured.",
    };
  let parked: { state?: string; verifier?: string };
  try {
    parked = JSON.parse(handoff ?? "");
  } catch {
    return {
      ok: false,
      code: "expired",
      error: "That authorisation link has expired. Start again.",
    };
  }
  if (
    !parked.state ||
    !parked.verifier ||
    !statesMatch(parked.state, params.state)
  )
    return {
      ok: false,
      code: "bad_state",
      error: "Authorisation could not be verified. Start again.",
    };

  let tokens: TokenSet;
  try {
    tokens = await exchangeCode(c, params.code, parked.verifier, f);
  } catch (e) {
    if (e instanceof CloudflareOauthError)
      return {
        ok: false,
        error: `Cloudflare refused the authorisation: ${e.message}`,
        code: e.code,
      };
    return { ok: false, error: `Could not reach Cloudflare: ${errMsg(e)}` };
  }

  let zones: CfZone[];
  try {
    zones = await new CloudflareClient(tokens.accessToken, f).listZones();
  } catch (e) {
    return {
      ok: false,
      error: `Cloudflare authorised us but the zone list failed: ${errMsg(e)}`,
    };
  }
  await persist(tokens, {
    // Only meaningful as a label when the grant sees exactly one zone.
    cloudflareAccountName: zones.length === 1 ? zones[0]!.name : null,
    cloudflareConnectedAt: new Date(),
  });
  await updateInstanceSettings({}, actor, { action: "cloudflare.connect" });
  return {
    ok: true,
    data: { zones, ...(zones.length === 0 && { warning: NO_ZONES }) },
  };
}

/** Refresh tokens are not always rotated; a missing one means keep the old. */
function persist(t: TokenSet, extra: Record<string, unknown> = {}) {
  return updateInstanceSettings(
    {
      cloudflareAccessToken: t.accessToken,
      ...(t.refreshToken && { cloudflareRefreshToken: t.refreshToken }),
      cloudflareTokenExpiresAt: t.expiresAt,
      ...extra,
    },
    undefined,
    { audit: false },
  );
}

export async function disconnectCloudflare(
  actor: InstanceActor,
  f: FetchLike = fetch,
): Promise<Result> {
  const c = oauthClient();
  const { cloudflareRefreshToken } = await getDecryptedSecrets();
  if (c && cloudflareRefreshToken) await revoke(c, cloudflareRefreshToken, f);
  await updateInstanceSettings(
    {
      cloudflareAccessToken: null,
      cloudflareRefreshToken: null,
      cloudflareTokenExpiresAt: null,
      cloudflareConnectedAt: null,
      cloudflareAccountName: null,
    },
    actor,
    { action: "cloudflare.disconnect" },
  );
  return { ok: true, data: undefined };
}

/**
 * A usable access token, refreshing first when the stored one is at or near
 * expiry. Null when Cloudflare was never connected, or when the refresh is
 * rejected — a revoked or expired grant clears our copy so the UI shows
 * "not connected" instead of failing every DNS write with a stale token.
 */
async function accessToken(f: FetchLike): Promise<string | null> {
  const s = await getInstanceSettings();
  if (!s.cloudflareConnectedAt) return null;
  const { cloudflareAccessToken, cloudflareRefreshToken } =
    await getDecryptedSecrets();
  if (cloudflareAccessToken && !isExpired(s.cloudflareTokenExpiresAt))
    return cloudflareAccessToken;
  const c = oauthClient();
  if (!c || !cloudflareRefreshToken) return null;
  try {
    const t = await refreshTokens(c, cloudflareRefreshToken, f);
    await persist(t);
    return t.accessToken;
  } catch (e) {
    console.warn(`[cloudflare] refresh failed, disconnecting: ${errMsg(e)}`);
    await updateInstanceSettings(
      {
        cloudflareAccessToken: null,
        cloudflareRefreshToken: null,
        cloudflareTokenExpiresAt: null,
        cloudflareConnectedAt: null,
        cloudflareAccountName: null,
      },
      undefined,
      { action: "cloudflare.grant_expired" },
    );
    return null;
  }
}

/** Client bound to a fresh access token, or null when Cloudflare isn't connected. */
export async function cloudflareClient(
  f: FetchLike = fetch,
): Promise<CloudflareClient | null> {
  const token = await accessToken(f);
  return token ? new CloudflareClient(token, f) : null;
}

export async function listZones(f: FetchLike = fetch): Promise<CfZone[]> {
  const cf = await cloudflareClient(f);
  if (!cf) return [];
  try {
    return await cf.listZones();
  } catch (e) {
    // A scope the user declined shows up here; treat it as "no zones" so
    // adding a domain still works and simply picks manual DNS.
    if (e instanceof CloudflareError) {
      console.warn(`[cloudflare] listZones failed: ${e.message}`);
      return [];
    }
    throw e;
  }
}
