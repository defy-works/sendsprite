/**
 * Stateless unsubscribe tokens (plan decision 5).
 *
 * NOTE: this module imports `node:crypto`. It is exported from
 * `@sendsprite/shared/node` only; the root barrel (and any browser bundle)
 * must not import it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A token is `base64url("<contactId>.<campaignId>.<sig>")`, where `sig` is
 * HMAC-SHA256 over `"<contactId>.<campaignId>"` keyed by `APP_SECRET`.
 *
 * Stateless on purpose. A stored token would mean one row per recipient per
 * campaign — 50 000 rows for a 50 000 send, plus a retention story — to buy
 * individual revocation of a link whose only power is to *remove* consent.
 * That is never the dangerous direction.
 *
 * Rotating `APP_SECRET` invalidates every outstanding link. That is already
 * true of every stored AWS and Cloudflare credential, and it is documented on
 * the self-hosting page.
 */
const sign = (contactId: string, campaignId: string, secret: string) =>
  createHmac("sha256", secret)
    .update(`${contactId}.${campaignId}`)
    .digest("base64url");

/**
 * A base64url token, bounded so an enormous string cannot make us decode and
 * hash indefinitely. A real token is ~140 characters; 512 leaves room for a
 * longer id format without leaving room for a payload.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{1,512}$/;

export function signUnsubscribeToken(
  contactId: string,
  campaignId: string,
  secret: string,
): string {
  // `createHmac("sha256", "")` is legal in Node, so an unset
  // `process.env.APP_SECRET ?? ""` would mint a well-formed link that anyone
  // could forge. A secret this side always comes from config: an empty one is
  // a bug, so fail loudly where it is introduced.
  if (!secret)
    throw new Error("signUnsubscribeToken: secret must not be empty.");
  // The dot is the field boundary, and ids are prefixed ULIDs that contain no
  // dot — that is the whole reason this packing is unambiguous. If an id
  // format ever changes, break here rather than emit a token whose fields
  // could be re-split somewhere else.
  for (const id of [contactId, campaignId])
    if (!id || id.includes("."))
      throw new Error(
        "signUnsubscribeToken: ids must be non-empty and contain no dot.",
      );
  const sig = sign(contactId, campaignId, secret);
  return Buffer.from(`${contactId}.${campaignId}.${sig}`, "utf8").toString(
    "base64url",
  );
}

export interface UnsubscribeTokenClaims {
  contactId: string;
  campaignId: string;
}

/**
 * Returns the claims, or `null` for anything that is not a valid token. Never
 * throws, and never distinguishes *why* it failed: the caller shows one
 * generic message for a bad signature and for an unknown contact alike, so a
 * token cannot be used to probe which ids exist. Nothing here logs, for the
 * same reason.
 */
export function verifyUnsubscribeToken(
  token: string,
  secret: string,
): UnsubscribeTokenClaims | null {
  // As above: never verify against the empty key.
  if (!secret) return null;
  // A route param is `string` by declaration only — a repeated query field
  // arrives as an array in several frameworks, and `Buffer.from(undefined)`
  // throws, which in an unsubscribe route is a 500 where the recipient should
  // have seen a page.
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;

  // Base64 decoding is lenient, so many strings decode to the same bytes.
  // Re-encoding and comparing gives a token exactly one spelling, so a cache
  // or rate-limiter keyed on the raw token cannot be walked past with a
  // padded or re-cased variant. It also rejects a payload that was not valid
  // UTF-8, which would otherwise survive as replacement characters.
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== token) return null;

  // Exactly three fields: ids and a base64url signature contain no dots, so a
  // token with any other count is either corrupt or an attempt to move the
  // boundary between the signed fields.
  const parts = decoded.split(".");
  if (parts.length !== 3) return null;
  const [contactId, campaignId, sig] = parts as [string, string, string];
  if (!contactId || !campaignId || !sig) return null;

  const expected = Buffer.from(sign(contactId, campaignId, secret), "utf8");
  const actual = Buffer.from(sig, "utf8");
  // `timingSafeEqual` throws on a length mismatch, and `sig` is attacker-
  // controlled. The length is not a secret: it is fixed at 43 characters for
  // every genuine token.
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;

  return { contactId, campaignId };
}
