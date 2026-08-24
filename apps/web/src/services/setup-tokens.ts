import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { newId } from "@sendsprite/shared";
import { db } from "@/db";
import { setupTokens } from "@/db/schema";

type Purpose = "aws_callback";
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** Returns the raw token exactly once; only its sha256 is stored. */
export async function issueSetupToken(i: {
  purpose: Purpose;
  issuedBy: string;
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
      region: i.region,
      expiresAt: new Date(Date.now() + i.ttlMs),
    });
  return { token, id };
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
  return row ?? null;
}

/** Latest unconsumed, unexpired token for the wizard's status poll. */
export async function pendingSetupToken(purpose: Purpose, issuedBy: string) {
  const [row] = await db()
    .select()
    .from(setupTokens)
    .where(
      and(
        eq(setupTokens.purpose, purpose),
        eq(setupTokens.issuedBy, issuedBy),
        isNull(setupTokens.consumedAt),
        gt(setupTokens.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(setupTokens.createdAt), desc(setupTokens.id))
    .limit(1);
  return row ?? null;
}
