import { eq } from "drizzle-orm";
import { db } from "@/db";
import { instanceSettings } from "@/db/schema";
import { getCipher } from "@/lib/crypto";

export type InstanceSettings = typeof instanceSettings.$inferSelect;

/** Creates the singleton row on first read. */
export async function getInstanceSettings(): Promise<InstanceSettings> {
  const [row] = await db()
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  if (row) return row;
  const [created] = await db()
    .insert(instanceSettings)
    .values({ id: 1 })
    .onConflictDoNothing()
    .returning();
  return created ?? (await getInstanceSettings());
}

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

/** Update plain columns; secret inputs are encrypted before writing. */
export async function updateInstanceSettings(
  patch: Plain & Secrets,
): Promise<InstanceSettings> {
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
  await getInstanceSettings();
  const [row] = await db()
    .update(instanceSettings)
    .set({ ...plain, ...enc, updatedAt: new Date() })
    .where(eq(instanceSettings.id, 1))
    .returning();
  return row!;
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
