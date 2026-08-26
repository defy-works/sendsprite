import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { instanceSettings } from "@/db/schema";
import { computeDiff, recordAudit, type RequestMeta } from "@/lib/audit";
import { getCipher } from "@/lib/crypto";

export type InstanceSettings = typeof instanceSettings.$inferSelect;

/** Who is changing instance settings (owner-level, so no team). */
export interface InstanceActor {
  userId: string;
  meta?: RequestMeta;
}

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
    | "cloudflareAccessTokenEnc"
    | "cloudflareRefreshTokenEnc"
  >
>;
type Secrets = {
  awsAccessKey?: string | null;
  awsSecret?: string | null;
  cloudflareAccessToken?: string | null;
  cloudflareRefreshToken?: string | null;
};

/**
 * Row as it appears in the audit diff: bookkeeping columns dropped. Secret
 * columns are compared as ciphertext so a rotation (set → set) still shows up;
 * `computeDiff` redacts them by key name, so the values never reach the log.
 * On a fresh instance `before` is undefined and the first update lists every
 * column as `{ to: … }`.
 */
function auditView(row: InstanceSettings | undefined): Record<string, unknown> {
  if (!row) return {};
  const view: Record<string, unknown> = { ...row };
  for (const col of ["id", "createdAt", "updatedAt"]) delete view[col];
  return view;
}

/**
 * Update plain columns; secret inputs are encrypted before writing.
 * Upsert, so it works on a fresh instance without a prior read.
 * Writes an instance-level audit row (`teamId: null`) describing the change,
 * unless `opts.audit` is false (bookkeeping writes such as `sesLastCheckedAt`).
 * `opts.action` names the row (default `instance.update`, the settings
 * form); connect/disconnect flows pass their own so the log reads as
 * events rather than diffs.
 */
export async function updateInstanceSettings(
  patch: Plain & Secrets,
  actor?: InstanceActor,
  opts: { audit?: boolean; action?: string } = {},
): Promise<InstanceSettings> {
  const before = await selectSingleton();
  const {
    awsAccessKey,
    awsSecret,
    cloudflareAccessToken,
    cloudflareRefreshToken,
    ...plain
  } = patch;
  const c = getCipher();
  const enc = {
    ...(awsAccessKey !== undefined && {
      awsAccessKeyEnc: awsAccessKey ? c.encrypt(awsAccessKey) : null,
    }),
    ...(awsSecret !== undefined && {
      awsSecretEnc: awsSecret ? c.encrypt(awsSecret) : null,
    }),
    ...(cloudflareAccessToken !== undefined && {
      cloudflareAccessTokenEnc: cloudflareAccessToken
        ? c.encrypt(cloudflareAccessToken)
        : null,
    }),
    ...(cloudflareRefreshToken !== undefined && {
      cloudflareRefreshTokenEnc: cloudflareRefreshToken
        ? c.encrypt(cloudflareRefreshToken)
        : null,
    }),
  };
  const set = { ...plain, ...enc, updatedAt: new Date() };
  const [row] = await db()
    .insert(instanceSettings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: instanceSettings.id, set })
    .returning();
  if (!row) throw new Error("instance_settings upsert returned no row");
  if (opts.audit === false) return row;
  await recordAudit({
    teamId: null,
    actorUserId: actor?.userId ?? null,
    action: opts.action ?? "instance.update",
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
    cloudflareAccessToken: s.cloudflareAccessTokenEnc
      ? c.decrypt(s.cloudflareAccessTokenEnc)
      : null,
    cloudflareRefreshToken: s.cloudflareRefreshTokenEnc
      ? c.decrypt(s.cloudflareRefreshTokenEnc)
      : null,
  };
}
