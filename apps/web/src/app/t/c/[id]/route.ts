import { loadEnv } from "@/env.schema";
import { verifyClick } from "@/lib/tracking";
import { recordTrackingHit } from "@/services/tracking";

export const dynamic = "force-dynamic";

const isHttp = (u: string) => {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
};

/**
 * Click redirect `/t/c/<emailId>?u=<url>&s=<sig>`. The signature binds the
 * url to the email id (see `signClick`), so this is not an open redirect:
 * a bad or missing signature, or a non-http(s) target, is a 400.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const u = q.get("u") ?? "";
  const s = q.get("s") ?? "";
  if (!u || !isHttp(u) || !verifyClick(id, u, s, loadEnv().APP_SECRET))
    return new Response("Bad link", {
      status: 400,
      headers: { "cache-control": "no-store, private" },
    });
  await recordTrackingHit(id, {
    type: "clicked",
    headers: req.headers,
    url: u,
  });
  return new Response(null, {
    status: 302,
    headers: { location: u, "cache-control": "no-store, private" },
  });
}
