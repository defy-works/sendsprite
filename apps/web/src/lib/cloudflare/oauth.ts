import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FetchLike } from "./client";

/**
 * Cloudflare's OAuth 2.0 endpoints, as published at
 * `https://dash.cloudflare.com/.well-known/openid-configuration`. They are
 * pinned here rather than discovered at runtime: discovery would add a
 * network round trip to every connect, and these have to be reachable for
 * the flow to work at all.
 *
 * Cloudflare supports only the Authorization Code grant for third-party
 * clients (no client credentials, no implicit), plus `refresh_token`.
 */
export const CF_OAUTH = {
  authorize: "https://dash.cloudflare.com/oauth2/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
} as const;

/** Clock skew allowance: a token this close to expiry is treated as expired. */
const EXPIRY_SKEW_MS = 60_000;

export interface OauthClient {
  clientId: string;
  clientSecret: string;
  /** Must exactly match one of the client's registered redirect URIs. */
  redirectUri: string;
  scopes: string;
}

export interface TokenSet {
  accessToken: string;
  /** Absent when Cloudflare declines to rotate it; keep the previous one. */
  refreshToken: string | null;
  expiresAt: Date;
}

export class CloudflareOauthError extends Error {
  constructor(
    msg: string,
    readonly code?: string,
  ) {
    super(msg);
    this.name = "CloudflareOauthError";
  }
}

const b64u = (b: Buffer) => b.toString("base64url");

/** PKCE pair (S256). The verifier never leaves the server. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export const newState = () => b64u(randomBytes(24));

/**
 * Constant-time compare for the `state` round trip, so a mismatch cannot be
 * probed byte-by-byte. Length differences short-circuit (already public).
 */
export function statesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Where to send the browser. PKCE is sent even though we authenticate the
 * token exchange with a client secret: it costs nothing and binds the code
 * to this particular request, so a leaked code alone is not redeemable.
 */
export function authorizeUrl(
  c: OauthClient,
  state: string,
  challenge: string,
): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    scope: c.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${CF_OAUTH.authorize}?${p}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** `client_secret_basic`: credentials in the Authorization header, not the body. */
const basicAuth = (c: OauthClient) =>
  `Basic ${Buffer.from(
    `${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`,
  ).toString("base64")}`;

async function postToken(
  c: OauthClient,
  form: Record<string, string>,
  f: FetchLike,
): Promise<TokenSet> {
  const res = await f(CF_OAUTH.token, {
    method: "POST",
    headers: {
      authorization: basicAuth(c),
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token)
    throw new CloudflareOauthError(
      body.error_description ?? body.error ?? `Cloudflare ${res.status}`,
      body.error,
    );
  // Cloudflare always sends expires_in; the fallback keeps a missing value
  // from being read as "expires now" and looping the refresh.
  const ttl = (body.expires_in ?? 3600) * 1000;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(Date.now() + ttl),
  };
}

export const exchangeCode = (
  c: OauthClient,
  code: string,
  verifier: string,
  f: FetchLike = fetch,
) =>
  postToken(
    c,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: c.redirectUri,
      code_verifier: verifier,
    },
    f,
  );

export const refreshTokens = (
  c: OauthClient,
  refreshToken: string,
  f: FetchLike = fetch,
) =>
  postToken(c, { grant_type: "refresh_token", refresh_token: refreshToken }, f);

/** True when the access token is expired or close enough that a call could race it. */
export const isExpired = (expiresAt: Date | null): boolean =>
  !expiresAt || expiresAt.getTime() - EXPIRY_SKEW_MS <= Date.now();

/**
 * Best-effort revocation on disconnect. Cloudflare revokes the whole grant
 * from the refresh token, so that is what we send. Failures are swallowed:
 * the user asked to disconnect, and we clear our copy either way — an
 * unrevoked token they can still kill from their Cloudflare profile is a
 * better outcome than a disconnect that refuses to complete.
 */
export async function revoke(
  c: OauthClient,
  token: string,
  f: FetchLike = fetch,
): Promise<boolean> {
  try {
    const res = await f(CF_OAUTH.revoke, {
      method: "POST",
      headers: {
        authorization: basicAuth(c),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        token,
        token_type_hint: "refresh_token",
      }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}
