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
import { cache } from "react";
import { eq } from "drizzle-orm";
import { loadEnv } from "@/env.schema";
import { db } from "@/db";
import { teamCloudflare } from "@/db/schema";
import { getCipher } from "@/lib/crypto";
import { recordAudit, type RequestMeta } from "@/lib/audit";
import type { Result } from "@/lib/result";

export type TeamCloudflare = typeof teamCloudflare.$inferSelect;

/** Who is changing a team's Cloudflare grant. */
export interface CfActor {
  userId: string;
  meta?: RequestMeta;
}

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
 * bookkeeping. The team id rides along so the callback binds the grant to the
 * team that started the flow. Encrypted with the instance cipher so neither
 * the verifier nor the team is readable even if the cookie leaks.
 */
export function beginOauth(teamId: string): Result<OauthStart> {
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
      // The team travels in the encrypted cookie, not a query parameter, so
      // the callback cannot be pointed at a team the browser never started a
      // consent flow for.
      handoff: JSON.stringify({ state, verifier, teamId }),
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
  actor: CfActor,
  f: FetchLike = fetch,
): Promise<Result<{ teamId: string; zones: CfZone[]; warning?: string }>> {
  const c = oauthClient();
  if (!c)
    return {
      ok: false,
      code: "not_configured",
      error: "This instance has no Cloudflare OAuth client configured.",
    };
  let parked: { state?: string; verifier?: string; teamId?: string };
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
    !parked.teamId ||
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
  const teamId = parked.teamId;
  await persist(teamId, tokens, {
    // Only meaningful as a label when the grant sees exactly one zone.
    accountName: zones.length === 1 ? zones[0]!.name : null,
    connectedAt: new Date(),
  });
  await recordAudit({
    teamId,
    actorUserId: actor.userId,
    action: "cloudflare.connect",
    targetType: "team_cloudflare",
    targetId: teamId,
    diff: { zones: { to: zones.length } },
    ...actor.meta,
  });
  return {
    ok: true,
    data: { teamId, zones, ...(zones.length === 0 && { warning: NO_ZONES }) },
  };
}

/** Null means this team has not authorised Cloudflare. */
export const getTeamCloudflare = cache(
  async (teamId: string): Promise<TeamCloudflare | null> => {
    const [row] = await db()
      .select()
      .from(teamCloudflare)
      .where(eq(teamCloudflare.teamId, teamId))
      .limit(1);
    return row ?? null;
  },
);

function decrypt(row: TeamCloudflare) {
  const c = getCipher();
  return {
    accessToken: c.decrypt(row.accessTokenEnc),
    refreshToken: row.refreshTokenEnc ? c.decrypt(row.refreshTokenEnc) : null,
  };
}

/**
 * Store a token set for one team. Cloudflare does not always rotate the
 * refresh token, so a missing one must leave the stored one alone — hence
 * the conditional spread rather than a blanket write.
 *
 * Like `team-aws.ts`, an explicit INSERT-or-UPDATE: `connectedAt` is NOT
 * NULL, and an `ON CONFLICT` upsert carrying only a refreshed access token
 * would fail its constraint check before ever finding the conflict.
 */
async function persist(
  teamId: string,
  t: TokenSet,
  extra: { accountName?: string | null; connectedAt?: Date } = {},
): Promise<TeamCloudflare> {
  const c = getCipher();
  const set = {
    accessTokenEnc: c.encrypt(t.accessToken),
    ...(t.refreshToken && { refreshTokenEnc: c.encrypt(t.refreshToken) }),
    tokenExpiresAt: t.expiresAt ?? null,
    ...extra,
    updatedAt: new Date(),
  };
  const existing = await getTeamCloudflare(teamId);
  const [row] = existing
    ? await db()
        .update(teamCloudflare)
        .set(set)
        .where(eq(teamCloudflare.teamId, teamId))
        .returning()
    : await db()
        .insert(teamCloudflare)
        .values({ teamId, connectedAt: new Date(), ...set })
        .returning();
  if (!row) throw new Error("team_cloudflare write returned no row");
  return row;
}

/** Forgetting the grant is a row delete, and the token is revoked first. */
async function forget(teamId: string, action: string, actor?: CfActor) {
  await db().delete(teamCloudflare).where(eq(teamCloudflare.teamId, teamId));
  await recordAudit({
    teamId,
    actorUserId: actor?.userId ?? null,
    action,
    targetType: "team_cloudflare",
    targetId: teamId,
    diff: null,
    ...actor?.meta,
  });
}

export async function disconnectCloudflare(
  teamId: string,
  actor: CfActor,
  f: FetchLike = fetch,
): Promise<Result> {
  const c = oauthClient();
  const row = await getTeamCloudflare(teamId);
  const refresh = row ? decrypt(row).refreshToken : null;
  if (c && refresh) await revoke(c, refresh, f);
  await forget(teamId, "cloudflare.disconnect", actor);
  return { ok: true, data: undefined };
}

/**
 * A usable access token for one team, refreshing first when the stored one is
 * at or near expiry. Null when Cloudflare was never connected, or when the
 * refresh is rejected — a revoked or expired grant clears our copy so the UI
 * shows "not connected" instead of failing every DNS write with a stale
 * token.
 */
async function accessToken(
  teamId: string,
  f: FetchLike,
): Promise<string | null> {
  const row = await getTeamCloudflare(teamId);
  if (!row) return null;
  const { accessToken: stored, refreshToken } = decrypt(row);
  if (stored && !isExpired(row.tokenExpiresAt)) return stored;
  const c = oauthClient();
  if (!c || !refreshToken) return null;
  try {
    const t = await refreshTokens(c, refreshToken, f);
    await persist(teamId, t);
    return t.accessToken;
  } catch (e) {
    console.warn(`[cloudflare] refresh failed, disconnecting: ${errMsg(e)}`);
    await forget(teamId, "cloudflare.grant_expired");
    return null;
  }
}

/** Client bound to a fresh access token, or null when Cloudflare isn't connected. */
export async function cloudflareClient(
  teamId: string,
  f: FetchLike = fetch,
): Promise<CloudflareClient | null> {
  const token = await accessToken(teamId, f);
  return token ? new CloudflareClient(token, f) : null;
}

export async function listZones(
  teamId: string,
  f: FetchLike = fetch,
): Promise<CfZone[]> {
  const cf = await cloudflareClient(teamId, f);
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
