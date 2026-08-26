import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/env";
import { requestMeta } from "@/lib/audit";
import { getCipher } from "@/lib/crypto";
import { requireTeamAdmin } from "@/lib/session";
import { completeOauth } from "@/services/cloudflare-connect";
import { HANDOFF_COOKIE, defaultReturn } from "../start/route";

export const dynamic = "force-dynamic";

/** Cloudflare's own `?error=` values are opaque to us; keep them short and safe to render. */
const slug = (s: string) => s.replace(/[^a-z0-9_-]/gi, "").slice(0, 64);

/**
 * Where Cloudflare returns the owner after the consent screen. Everything
 * here ends in a redirect back to the page they started from, with
 * `?cloudflare=connected` or `?error=…` for the UI to render — a bare JSON
 * error would strand them on an API URL.
 */
export async function GET(req: Request) {
  const ctx = await requireTeamAdmin();
  const jar = await cookies();
  const raw = jar.get(HANDOFF_COOKIE)?.value;
  // Read once: whatever happens below, this handoff must not be replayable.
  jar.delete({ name: HANDOFF_COOKIE, path: "/api/setup/cloudflare" });

  let parked: { handoff?: string; returnTo?: string } = {};
  try {
    if (raw) parked = JSON.parse(getCipher().decrypt(raw));
  } catch {
    // Tampered or encrypted under a rotated APP_SECRET; treated as absent.
  }
  /**
   * Redirect back to where the flow started, with one status parameter added.
   *
   * Built through `URL` rather than string concatenation because the return
   * targets now carry a fragment (`/app/settings#sending`, so the long
   * Settings page opens at the right band). Appending `?error=…` to that
   * string puts the query *inside* the fragment, where no server and no
   * `useSearchParams` will ever see it — the user lands on a Settings page
   * that quietly shows Cloudflare as disconnected and says nothing about why.
   */
  const back = (key: string, value: string) => {
    const url = new URL(parked.returnTo ?? defaultReturn, env.APP_URL);
    url.searchParams.set(key, value);
    return NextResponse.redirect(url);
  };

  const p = new URL(req.url).searchParams;
  // The user pressed Cancel, or Cloudflare refused the request outright.
  const denied = p.get("error");
  if (denied) return back("error", slug(denied));

  const code = p.get("code");
  const state = p.get("state");
  if (!code || !state) return back("error", "invalid_response");

  const res = await completeOauth({ code, state }, parked.handoff, {
    userId: ctx.userId,
    meta: requestMeta(await headers()),
  });
  if (!res.ok) return back("error", slug(res.code ?? "connect_failed"));
  return back("cloudflare", res.data.warning ? "no_zones" : "connected");
}
