import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { newId } from "@sendsprite/shared";
import { db } from "@/db";
import { organization, setupTokens } from "@/db/schema";

type Purpose = "aws_callback";
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** Returns the raw token exactly once; only its sha256 is stored. */
export async function issueSetupToken(i: {
  purpose: Purpose;
  issuedBy: string;
  /** The team the stack will connect; the callback reads it back off the row. */
  teamId: string;
  region: string;
  ttlMs: number;
}) {
  const token = randomBytes(32).toString("base64url");
  const id = newId("stok");
  await db()
    .insert(setupTokens)
    .values({
      id,
      purpose: i.purpose,
      tokenHash: hash(token),
      issuedBy: i.issuedBy,
      teamId: i.teamId,
      region: i.region,
      expiresAt: new Date(Date.now() + i.ttlMs),
    });
  return { token, id };
}

/**
 * Drops every unconsumed token this user holds **for this team**, so at most
 * one quick-create link is live per team (a stale tab cannot connect an older
 * stack later). Scoped to the team as well as the user: someone who
 * administers two teams must be able to have a pending connect in each.
 * Returns the number revoked.
 *
 * A `DELETE` rather than the `consumedAt = now()` it used to be. Once
 * {@link inFlightSetupToken} exists, "consumed, not failed, recently" *means*
 * "a callback is running right now", and superseding a link the user abandoned
 * would have forged exactly that state — the wizard would sit on "Waiting for
 * CloudFormation…" for a stack nobody ever created. Deleting is also the
 * honest record: an unconsumed token that was replaced never authorised
 * anything, so there is no history in it to keep.
 */
export async function revokePendingSetupTokens(
  purpose: Purpose,
  issuedBy: string,
  teamId: string,
): Promise<number> {
  const rows = await db()
    .delete(setupTokens)
    .where(
      and(
        eq(setupTokens.purpose, purpose),
        eq(setupTokens.issuedBy, issuedBy),
        eq(setupTokens.teamId, teamId),
        isNull(setupTokens.consumedAt),
      ),
    )
    .returning({ id: setupTokens.id });
  return rows.length;
}

/**
 * Atomically marks the token consumed (single `UPDATE … RETURNING`, so two
 * concurrent callbacks cannot both succeed); null when unknown, expired or
 * already used.
 */
export async function consumeSetupToken(purpose: Purpose, token: string) {
  const [row] = await db()
    .update(setupTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(setupTokens.purpose, purpose),
        eq(setupTokens.tokenHash, hash(token)),
        isNull(setupTokens.consumedAt),
        gt(setupTokens.expiresAt, sql`now()`),
      ),
    )
    .returning();
  if (!row?.teamId) return null;
  // The slug names the AWS resources, and the callback has no session to
  // resolve a team from — so it is read here, with the token.
  const [org] = await db()
    .select({ slug: organization.slug })
    .from(organization)
    .where(eq(organization.id, row.teamId))
    .limit(1);
  if (!org) return null;
  return { ...row, teamId: row.teamId, teamSlug: org.slug };
}

/**
 * A token that has been consumed but whose callback has not finished.
 *
 * This is the difference between "the link expired" and "AWS is calling us
 * right now". The callback burns the token *first* — atomically, so two
 * concurrent callbacks cannot both win — and only then runs `connectWithKeys`,
 * which creates a configuration set, an SNS topic, a subscription and an event
 * destination in the tenant's account. That takes tens of seconds.
 *
 * For that whole window the wizard's poll saw `connected: false` and
 * `pendingToken: false` and concluded the link had expired, every time. The
 * report was "the one-click always expires before it completes", and it was
 * exactly right: the two states the poll distinguished did not cover the state
 * the flow spends most of its time in.
 *
 * Bounded by `withinMs` rather than open-ended, so a callback whose process
 * died mid-provision eventually reads as failed instead of spinning for ever.
 * `failedAt` short-circuits it: a callback that recorded a reason is finished,
 * and the reason is the better thing to show.
 */
export async function inFlightSetupToken(
  purpose: Purpose,
  issuedBy: string,
  teamId: string,
  withinMs: number,
) {
  const [row] = await db()
    .select({ id: setupTokens.id, consumedAt: setupTokens.consumedAt })
    .from(setupTokens)
    .where(
      and(
        eq(setupTokens.purpose, purpose),
        eq(setupTokens.issuedBy, issuedBy),
        eq(setupTokens.teamId, teamId),
        isNotNull(setupTokens.consumedAt),
        isNull(setupTokens.failedAt),
        gt(setupTokens.consumedAt, new Date(Date.now() - withinMs)),
      ),
    )
    .orderBy(desc(setupTokens.consumedAt))
    .limit(1);
  return row ?? null;
}

/** Latest unconsumed, unexpired token for the wizard's status poll. */
export async function pendingSetupToken(
  purpose: Purpose,
  issuedBy: string,
  teamId: string,
) {
  const [row] = await db()
    .select()
    .from(setupTokens)
    .where(
      and(
        eq(setupTokens.purpose, purpose),
        eq(setupTokens.issuedBy, issuedBy),
        eq(setupTokens.teamId, teamId),
        isNull(setupTokens.consumedAt),
        gt(setupTokens.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(setupTokens.createdAt), desc(setupTokens.id))
    .limit(1);
  return row ?? null;
}

/** The token is already burned; remember why the callback failed so /status can show it. */
export async function recordSetupFailure(id: string, reason: string) {
  await db()
    .update(setupTokens)
    .set({ failedAt: new Date(), failedReason: reason })
    .where(eq(setupTokens.id, id));
}

/** Newest failed callback for this user in this team, or null. */
export async function lastSetupFailure(
  purpose: Purpose,
  issuedBy: string,
  teamId: string,
) {
  const [row] = await db()
    .select({ at: setupTokens.failedAt, reason: setupTokens.failedReason })
    .from(setupTokens)
    .where(
      and(
        eq(setupTokens.purpose, purpose),
        eq(setupTokens.issuedBy, issuedBy),
        eq(setupTokens.teamId, teamId),
        isNotNull(setupTokens.failedAt),
      ),
    )
    .orderBy(desc(setupTokens.failedAt), desc(setupTokens.id))
    .limit(1);
  return row?.at ? { at: row.at, reason: row.reason ?? "" } : null;
}
