import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/env";
import { getCipher } from "@/lib/crypto";
import { requireOwner } from "@/lib/session";
import { beginOauth } from "@/services/cloudflare-connect";

export const dynamic = "force-dynamic";

export const HANDOFF_COOKIE = "ss_cf_oauth";
/** Long enough to read a consent screen, short enough that a stale tab fails closed. */
const HANDOFF_TTL_S = 600;

/** Only ever back into our own setup surfaces; a stray `?from=` cannot become an open redirect. */
const RETURNS = ["/setup?step=cloudflare", "/app/settings/instance"] as const;
export const defaultReturn = RETURNS[0];

/**
 * Sends the owner to Cloudflare's consent screen. The `state` and PKCE
 * verifier are parked in an encrypted, httpOnly cookie: `SameSite=Lax` still
 * sends it on the top-level GET that Cloudflare redirects back to, and
 * nothing else can read it.
 */
export async function GET(req: Request) {
  await requireOwner();
  const res = beginOauth();
  if (!res.ok)
    return NextResponse.redirect(
      new URL(`${defaultReturn}&error=${res.code ?? "failed"}`, env.APP_URL),
    );
  const asked = new URL(req.url).searchParams.get("from");
  const returnTo = RETURNS.find((r) => r === asked) ?? defaultReturn;
  const jar = await cookies();
  jar.set(
    HANDOFF_COOKIE,
    getCipher().encrypt(
      JSON.stringify({ handoff: res.data.handoff, returnTo }),
    ),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: env.APP_URL.startsWith("https://"),
      path: "/api/setup/cloudflare",
      maxAge: HANDOFF_TTL_S,
    },
  );
  return NextResponse.redirect(res.data.url);
}
