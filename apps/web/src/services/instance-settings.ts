import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { instanceSettings } from "@/db/schema";
import { computeDiff, recordAudit, type RequestMeta } from "@/lib/audit";
import { getCipher } from "@/lib/crypto";

export type InstanceSettings = typeof instanceSettings.$inferSelect;

async function selectSingleton() {
  const [row] = await db()
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  return row;
}

/**
 * Creates the singleton row on first read. Request-scoped (`React.cache`)
 * so layout + page share one query; outside a request it is a plain call.
 */
export const getInstanceSettings = cache(
  async (): Promise<InstanceSettings> => {
    const existing = await selectSingleton();
    if (existing) return existing;
    await db().insert(instanceSettings).values({ id: 1 }).onConflictDoNothing();
    const row = await selectSingleton();
    if (!row) throw new Error("instance_settings singleton missing");
    return row;
  },
);

/** Plain columns only: encrypted columns are written via `Secrets`. */
type Plain = Partial<
  Omit<
    InstanceSettings,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "awsAccessKeyEnc"
    | "awsSecretEnc"
    | "cloudflareTokenEnc"
  >
>;
type Secrets = {
  awsAccessKey?: string | null;
  awsSecret?: string | null;
  cloudflareToken?: string | null;
};

const ENC_COLUMNS = [
  "awsAccessKeyEnc",
  "awsSecretEnc",
  "cloudflareTokenEnc",
] as const;

/**
 * Row as it appears in the audit diff: bookkeeping columns dropped, secret
 * columns reduced to a set/cleared marker (`computeDiff` redacts them by key
 * anyway, so only the fact that they changed is recorded).
 */
function auditView(row: InstanceSettings | undefined): Record<string, unknown> {
  if (!row) return {};
  const view: Record<string, unknown> = { ...row };
  for (const col of ["id", "createdAt", "updatedAt"]) delete view[col];
  for (const col of ENC_COLUMNS) view[col] = row[col] ? "[set]" : null;
  return view;
}

/**
 * Update plain columns; secret inputs are encrypted before writing.
 * Upsert, so it works on a fresh instance without a prior read.
 * Writes an instance-level audit row (`teamId: null`) describing the change.
 */
export async function updateInstanceSettings(
  patch: Plain & Secrets,
  actor?: { userId: string; meta?: RequestMeta },
): Promise<InstanceSettings> {
  const before = await selectSingleton();
  const { awsAccessKey, awsSecret, cloudflareToken, ...plain } = patch;
  const c = getCipher();
  const enc = {
    ...(awsAccessKey !== undefined && {
      awsAccessKeyEnc: awsAccessKey ? c.encrypt(awsAccessKey) : null,
    }),
    ...(awsSecret !== undefined && {
      awsSecretEnc: awsSecret ? c.encrypt(awsSecret) : null,
    }),
    ...(cloudflareToken !== undefined && {
      cloudflareTokenEnc: cloudflareToken ? c.encrypt(cloudflareToken) : null,
    }),
  };
  const set = { ...plain, ...enc, updatedAt: new Date() };
  const [row] = await db()
    .insert(instanceSettings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: instanceSettings.id, set })
    .returning();
  if (!row) throw new Error("instance_settings upsert returned no row");
  await recordAudit({
    teamId: null,
    actorUserId: actor?.userId ?? null,
    action: "instance.update",
    targetType: "instance",
    targetId: "1",
    diff: computeDiff(auditView(before), auditView(row)),
    ...actor?.meta,
  });
  return row;
}

export async function getDecryptedSecrets() {
  const s = await getInstanceSettings();
  const c = getCipher();
  return {
    awsAccessKey: s.awsAccessKeyEnc ? c.decrypt(s.awsAccessKeyEnc) : null,
    awsSecret: s.awsSecretEnc ? c.decrypt(s.awsSecretEnc) : null,
    cloudflareToken: s.cloudflareTokenEnc
      ? c.decrypt(s.cloudflareTokenEnc)
      : null,
  };
}
