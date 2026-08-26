import { enqueue } from "@/jobs/enqueue";
import { requestMeta } from "@/lib/audit";
import { applyUnsubscribe } from "@/services/unsubscribe";

export const dynamic = "force-dynamic";

/** Next 16 hands a route handler its dynamic segments as a promise. */
type Ctx = { params: Promise<{ token: string }> };

/**
 * `no-store` on every answer, and `noindex` for anything that crawls: the path
 * segment is a live credential, so no shared cache and no search index may
 * keep a copy of it. `referrer-policy` for the same reason — nothing here
 * links out, but a `Referer` is the classic way a URL escapes into somebody
 * else's logs, and saying so at the door beats relying on there never being a
 * link.
 */
const HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store, private",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
} as const;

/**
 * `POST /api/unsubscribe/:token` — the RFC 8058 one-click endpoint named by
 * `List-Unsubscribe-Post`.
 *
 * ## Deliberately not CSRF-protected, and deliberately unauthenticated
 *
 * A considered exception, not an oversight, and not to be "fixed". RFC 8058
 * requires an unauthenticated cross-origin POST issued by a mail client: there
 * is no session to bind a CSRF token to, and no origin we could predict —
 * Gmail, Outlook and every other client POST from infrastructure we have never
 * seen. The HMAC in the path *is* the authorisation.
 *
 * What makes that safe is the blast radius rather than the check. The only
 * action this endpoint authorises is **removing consent**, so a forged request
 * achieves exactly what the recipient could achieve by pressing the button
 * themselves. The dangerous directions are not reachable from here at all:
 * nothing resubscribes, nothing writes a suppression, and nothing is read back
 * — the response body is a fixed string, identical for every outcome.
 *
 * ## Always 200, even for a bad token
 *
 * A mail client that shows an error teaches the recipient to press the spam
 * button instead, and a complaint costs the sender orders of magnitude more
 * reputation than an unsubscribe does. So a forged token, a rotated secret and
 * a deleted contact all answer 200 with the same body as a successful removal.
 * The honest account of what happened lives on the human page
 * (`/unsubscribe/:token`), where somebody can act on it; this endpoint is
 * talking to a machine whose only two behaviours are "quiet" and "alarm the
 * user".
 *
 * The one exception is the rate limiter, which answers **429 with
 * `Retry-After`**. That is not a statement about the token but about the load,
 * and it is the single refusal a conforming client should retry. Answering 200
 * while dropping the write would leave someone still subscribed after being
 * told they were not — a consent failure, and the worst outcome available on
 * this surface.
 *
 * **Nothing in this handler logs.** The token is the credential; it never
 * reaches a log line, an error message or a response body.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  const outcome = await applyUnsubscribe(token, {
    enqueue,
    meta: requestMeta(req.headers),
  });
  if (outcome === "rate_limited")
    return new Response("Please try again in a moment.\n", {
      status: 429,
      headers: { ...HEADERS, "retry-after": "60" },
    });
  // `unsubscribed` and `invalid` share one answer on purpose: see above, and
  // see `services/unsubscribe.ts` for why the two failures behind `invalid`
  // are themselves indistinguishable.
  return new Response("You have been unsubscribed.\n", {
    status: 200,
    headers: HEADERS,
  });
}

/**
 * A GET here is a link scanner, a curious human, or a client that ignored
 * `List-Unsubscribe-Post`. Send them to the page, which is the surface built
 * for a person.
 *
 * **This redirect mutates nothing.** That is the whole point of the GET/POST
 * split, and it has to hold on both sides of it: a scanner that follows the
 * `List-Unsubscribe` header must end up somewhere that only renders.
 */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  return new Response(null, {
    status: 302,
    headers: {
      ...HEADERS,
      location: `/unsubscribe/${encodeURIComponent(token)}`,
    },
  });
}
