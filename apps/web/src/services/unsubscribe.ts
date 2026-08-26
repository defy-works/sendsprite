import { eq } from "drizzle-orm";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "@sendsprite/shared/node";
import { db } from "@/db";
import { contacts, organization } from "@/db/schema";
import { loadEnv } from "@/env.schema";
import type { RequestMeta } from "@/lib/audit";
import { unsubscribeContact, type ContactDeps } from "./contacts";
import type { TeamActor } from "./team";

/**
 * The public unsubscribe surface: the read behind `GET /unsubscribe/:token`,
 * the write behind `POST /api/unsubscribe/:token`, and the RFC 8058 header
 * pair the fan-out stamps on every campaign row.
 *
 * ## Nothing in this file ever logs the token
 *
 * The token *is* the authorisation. A token in an access log, an error report
 * or a breadcrumb is a working unsubscribe link for that recipient, sitting in
 * a system whose read access is far wider than the mailbox it came from. So
 * every failure here is a plain value (`"invalid"`), never a thrown error
 * carrying the token in its message, and no branch logs the credential — only
 * the outcome, and only where an outcome is worth recording (the audit row
 * `unsubscribeContact` writes, which names the campaign, not the token).
 *
 * ## It writes no suppression row
 *
 * This is Phase 6 Decision 3 reaching a new surface. Leaving a newsletter must
 * not stop that person's password resets, and for a receipt that is a legal
 * problem rather than a support one. The write goes through
 * `unsubscribeContact`, the one implementation of "consent off, deliverability
 * untouched" — that is why this module delegates instead of running its own
 * `update`, and why nothing here imports `services/suppressions.ts`.
 *
 * ## An invalid token and an unknown contact are indistinguishable
 *
 * `verifyUnsubscribeToken` already returns a bare `null` for every failure.
 * This module keeps that property downstream: both cases return the same
 * value, both callers render the same words, and — see `loadContact` — both
 * cost the same single database round-trip, so the endpoint cannot be used to
 * probe which contact ids exist.
 */

/** Bare-string outcomes: no branch here carries the token into its result. */
export type UnsubscribeOutcome = "unsubscribed" | "invalid" | "rate_limited";

export interface UnsubscribeTarget {
  /** The recipient's address, for the confirmation copy. */
  email: string;
  /** The team that sent the campaign; `null` when the team row is gone. */
  senderName: string | null;
  /** Current consent. `false` renders the same confirmation as a fresh POST. */
  subscribed: boolean;
}

/**
 * A contact id that cannot exist: ids are `ct_` + a Crockford-base32 ULID,
 * which never contains a lowercase letter. See `loadContact`.
 */
const NO_SUCH_CONTACT = "ct_no_such_contact";

/**
 * One indexed primary-key lookup, whatever the token was.
 *
 * A bad signature costs an HMAC and nothing else; a good signature naming a
 * deleted contact costs an HMAC *and* a query. Answering the first without
 * touching the database would make the two measurably different from outside
 * — exactly the "does this id exist?" oracle the token verifier goes out of
 * its way not to be. So an unverifiable token is looked up too, against an id
 * no ULID can spell, and the row is discarded either way.
 *
 * This buys the same *shape*, not constant time: the query dominates, and
 * claiming more would be a comment the code cannot keep.
 */
async function loadContact(contactId: string) {
  const [row] = await db()
    .select({
      id: contacts.id,
      email: contacts.email,
      teamId: contacts.teamId,
      subscribed: contacts.subscribed,
      senderName: organization.name,
    })
    .from(contacts)
    // The campaign is deliberately not joined. A campaign deleted after it
    // sent must not break the unsubscribe links already sitting in people's
    // inboxes: the token names the campaign so the reason can, but consent is
    // a fact about the contact and outlives whatever prompted it.
    .leftJoin(organization, eq(organization.id, contacts.teamId))
    .where(eq(contacts.id, contactId))
    .limit(1);
  return row ?? null;
}

/**
 * What `GET /unsubscribe/:token` renders. **Read-only** — this is the half of
 * the surface link scanners reach, and it must stay a pure read.
 *
 * `null` means "this link does not work", for a forged token and for a
 * departed contact alike.
 */
export async function describeUnsubscribe(
  token: string,
): Promise<UnsubscribeTarget | null> {
  const claims = verifyUnsubscribeToken(token, loadEnv().APP_SECRET);
  const row = await loadContact(claims?.contactId ?? NO_SUCH_CONTACT);
  if (!claims || !row) return null;
  return {
    email: row.email,
    senderName: row.senderName,
    subscribed: row.subscribed,
  };
}

export interface ApplyUnsubscribeOptions extends ContactDeps {
  /** Client ip / UA for the rate limiter and the audit row. */
  meta?: RequestMeta;
}

/**
 * Removes consent. The only mutating entry point on this surface, reached by
 * `POST /api/unsubscribe/:token` and by the page's button — never by a GET.
 *
 * Idempotent: an already-unsubscribed contact answers `"unsubscribed"` too,
 * because a link clicked twice is not an error and the recipient must see the
 * same confirmation either way.
 */
export async function applyUnsubscribe(
  token: string,
  opts: ApplyUnsubscribeOptions,
): Promise<UnsubscribeOutcome> {
  const claims = verifyUnsubscribeToken(token, loadEnv().APP_SECRET);
  // After the (free) HMAC and before the write: a refused request must not
  // reach `unsubscribeContact`, and the limiter must not become a shortcut
  // that makes a bad token cheaper to probe than a good one.
  if (!takeUnsubscribeToken(opts.meta?.ip ?? null, opts.now))
    return "rate_limited";
  const row = await loadContact(claims?.contactId ?? NO_SUCH_CONTACT);
  if (!claims || !row) return "invalid";

  const actor: TeamActor = {
    // There is no session here and no user: the recipient authenticated with
    // an HMAC, so the actor is the link itself. `api:<key id>` in
    // `lib/api-auth.ts` sets the precedent for a namespaced pseudo-actor, and
    // naming the campaign makes the audit row say which mail prompted this.
    // `member` is the least role holding `contacts.manage`: this path needs
    // that one permission and must not borrow any other.
    userId: `unsubscribe:${claims.campaignId}`,
    teamId: row.teamId,
    teamName: row.senderName ?? "",
    role: "member",
    ...(opts.meta ? { meta: opts.meta } : {}),
  };
  const res = await unsubscribeContact(
    actor,
    {
      email: row.email,
      // Across every book of the team, not only the campaign's: the person
      // said stop, not "stop for book A" (see `unsubscribeContact`).
      reason: `campaign:${claims.campaignId}`,
    },
    { enqueue: opts.enqueue, ...(opts.now ? { now: opts.now } : {}) },
  );
  // A refusal here would be a bug on our side rather than a fact about the
  // token, and the recipient can do nothing with it. Report it as unusable
  // rather than inventing a third thing for the page to say.
  return res.ok ? "unsubscribed" : "invalid";
}

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

/**
 * Per-ip token bucket over the unsubscribe write, refilling continuously the
 * way `takeSesToken` does.
 *
 * **This is not brute-force protection.** The token is a 256-bit HMAC; nobody
 * is guessing one, and a limiter that implied otherwise would be theatre. What
 * it protects against is more mundane and far more likely: one broken mail
 * client, or one scanner that decided to retry the one-click POST, hammering
 * `unsubscribeContact` — a write, an audit insert and a webhook fan-out per
 * call — in a loop.
 *
 * Deliberately in-memory and per-process. A shared bucket wants a table and a
 * migration this task does not own, and the failure it exists to contain is
 * one client against one instance. The cost is that a two-instance deployment
 * allows twice the rate, which is fine for a limit whose job is to blunt a
 * loop rather than to enforce a quota.
 */
const BURST = 20;
const REFILL_PER_SEC = 20 / 60;

/**
 * Bound on tracked ips. The key comes from a client-suppliable header, so an
 * unbounded map is a memory-exhaustion vector dressed as a rate limiter. At
 * the cap the idle (fully refilled) entries go first and, failing that, the
 * whole map is dropped: the worst case of forgetting is that some clients get
 * a fresh allowance, and leniency is the right failure mode for a limiter
 * standing in front of a consent action.
 */
const MAX_TRACKED = 10_000;
const buckets = new Map<string, { tokens: number; at: number }>();

/**
 * Exported for the tests, which need a limiter starting from a known state
 * rather than from whatever the previous test in the file spent.
 */
export function resetUnsubscribeLimitsForTests(): void {
  buckets.clear();
}

/**
 * `true` when the caller may proceed.
 *
 * An unknown ip is **not** limited. Behind a proxy that sets
 * `x-forwarded-for` every request has an identity; without one, no request
 * does, and funnelling them all into a single shared bucket would let one
 * looping client deny everyone else's unsubscribe — precisely the outcome
 * this surface exists to prevent. Failing open there, and documenting the
 * proxy requirement, is the lesser harm.
 */
export function takeUnsubscribeToken(
  ip: string | null,
  now = new Date(),
): boolean {
  if (!ip) return true;
  const at = now.getTime();
  const prev = buckets.get(ip);
  // A clock that went backwards must not credit tokens twice.
  const elapsed = prev ? Math.max(0, at - prev.at) / 1000 : 0;
  const tokens = Math.min(
    BURST,
    (prev?.tokens ?? BURST) + elapsed * REFILL_PER_SEC,
  );
  if (!prev && buckets.size >= MAX_TRACKED) evict(at);
  const ok = tokens >= 1;
  buckets.set(ip, { tokens: ok ? tokens - 1 : tokens, at });
  return ok;
}

/** Drop entries that have refilled completely; clear everything if none had. */
function evict(at: number): void {
  const fullMs = (BURST / REFILL_PER_SEC) * 1000;
  for (const [key, b] of buckets)
    if (at - b.at >= fullMs || b.tokens >= BURST) buckets.delete(key);
  if (buckets.size >= MAX_TRACKED) buckets.clear();
}

/* ------------------------------------------------------------------ *
 * The links the fan-out stamps on every campaign row
 * ------------------------------------------------------------------ */

export interface UnsubscribeLinks {
  /** For the body footer. A GET here confirms; it never unsubscribes. */
  pageUrl: string;
  /** RFC 8058, verbatim. Both fields or neither — see below. */
  headers: {
    "List-Unsubscribe": string;
    "List-Unsubscribe-Post": string;
  };
}

/**
 * The per-recipient unsubscribe links for one campaign row.
 *
 * The two URLs are **different on purpose**:
 *
 * - `pageUrl` (`/unsubscribe/:token`) is for humans. It is a page, so a GET
 *   renders a button and changes nothing — which is what makes it safe to put
 *   in a body that Defender, Proofpoint and Mimecast will each fetch before a
 *   person ever sees the message.
 * - `List-Unsubscribe` names `/api/unsubscribe/:token`, because RFC 8058 says
 *   the URI in that header must accept a POST, and an App Router segment
 *   holding a `page.tsx` cannot also export a `POST` handler. Pointing the
 *   header at the page would make Gmail's and Outlook's native button answer
 *   405 — a silently broken one-click, which is the expensive kind.
 *
 * `List-Unsubscribe-Post` is never emitted without its partner: alone it is a
 * header no client acts on, and its absence beside a `List-Unsubscribe` is
 * what makes the native button disappear and leaves the spam button as the
 * recipient's only way out. Returning the pair as one object is how that stays
 * true at every call site.
 */
export function unsubscribeLinks(
  contactId: string,
  campaignId: string,
): UnsubscribeLinks {
  const env = loadEnv();
  const base = env.APP_URL.replace(/\/+$/, "");
  const token = signUnsubscribeToken(contactId, campaignId, env.APP_SECRET);
  return {
    pageUrl: `${base}/unsubscribe/${token}`,
    headers: {
      "List-Unsubscribe": `<${base}/api/unsubscribe/${token}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
