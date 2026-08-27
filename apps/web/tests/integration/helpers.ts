import { randomBytes } from "node:crypto";
import { db } from "@/db";
import { organization } from "@/db/schema";
import {
  createApiKey,
  PREFIX_LEN,
  type ApiKeyPermission,
} from "@/services/api-keys";
import type { TeamActor } from "@/services/team";

/**
 * A fresh team with one API key (`full` unless told otherwise) in the
 * database `startPg()` booted for this file. Ids are random so a test can
 * call it more than once. `APP_SECRET` (the keys are hashed with it) is set
 * when the file has not set one already. `actor` is an owner of the team for
 * seeding more rows through the services.
 */
export async function seedTeamWithKey({
  permission = "full",
  name = "seed",
}: { permission?: ApiKeyPermission; name?: string } = {}) {
  process.env.APP_SECRET ??= "x".repeat(40);
  const suffix = randomBytes(4).toString("hex");
  const team = { id: `org_${suffix}`, name: `Team ${suffix}`, slug: suffix };
  await db()
    .insert(organization)
    .values({ ...team, createdAt: new Date() });
  const actor: TeamActor = {
    userId: `u_${suffix}`,
    teamId: team.id,
    teamName: team.name,
    role: "owner",
  };
  const res = await createApiKey(actor, { name, permission });
  if (!res.ok) throw new Error(`seed failed: ${res.error}`);
  return {
    team,
    actor,
    key: {
      id: res.data.id,
      name,
      permission,
      keyPrefix: res.data.secret.slice(0, PREFIX_LEN),
    },
    secret: res.data.secret,
  };
}

/**
 * Give a team a connected AWS account. Tests used to reach for
 * `updateInstanceSettings` directly; a helper keeps the intent readable and
 * means the next signature change touches one file instead of fourteen.
 *
 * Defaults are a production-access account so a test that only cares about
 * sending does not have to spell one out.
 */
export async function connectTeamAws(
  teamId: string,
  patch: Partial<{
    region: string;
    accountId: string;
    configSet: string;
    snsTopicArn: string;
    snsSubscriptionArn: string | null;
    sesAccountStatus: "sandbox" | "requested" | "production";
    sesReviewStatus: "PENDING" | "GRANTED" | "DENIED" | "FAILED";
    sesDailyQuota: number | null;
    sesMaxSendRate: number | null;
    sesLastCheckedAt: Date;
  }> = {},
) {
  process.env.APP_SECRET ??= "x".repeat(40);
  const { updateTeamAws } = await import("@/services/team-aws");
  return updateTeamAws(
    teamId,
    {
      region: "us-east-1",
      accessKey: "AKIAEXAMPLEEXAMPLE",
      secret: "s3cr3ts3cr3ts3cr3ts3cr3t",
      accountId: "123456789012",
      configSet: "sendsprite-test",
      connectedAt: new Date(),
      sesAccountStatus: "production",
      ...patch,
    },
    undefined,
    { audit: false },
  );
}

/** Forget a team's AWS connection (the "not configured" path). */
export async function disconnectTeamAwsForTests(teamId: string) {
  const { db } = await import("@/db");
  const { teamAws } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  await db().delete(teamAws).where(eq(teamAws.teamId, teamId));
}

/**
 * Seed a live Cloudflare grant for a team without the consent round trip —
 * that is covered in `cloudflare-connect.test.ts`, and going through it here
 * would mean faking Cloudflare's token endpoint in every caller.
 */
export async function connectTeamCloudflare(
  teamId: string,
  { accountName = null as string | null } = {},
) {
  process.env.APP_SECRET ??= "x".repeat(40);
  const { db } = await import("@/db");
  const { teamCloudflare } = await import("@/db/schema");
  const { getCipher } = await import("@/lib/crypto");
  const c = getCipher();
  const set = {
    accessTokenEnc: c.encrypt("cf-access-token"),
    refreshTokenEnc: c.encrypt("cf-refresh-token"),
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    accountName,
    connectedAt: new Date(),
    updatedAt: new Date(),
  };
  await db()
    .insert(teamCloudflare)
    .values({ teamId, ...set })
    .onConflictDoUpdate({ target: teamCloudflare.teamId, set });
}

/** Forget a team's Cloudflare grant (the manual-DNS path). */
export async function forgetTeamCloudflare(teamId: string) {
  const { db } = await import("@/db");
  const { teamCloudflare } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  await db().delete(teamCloudflare).where(eq(teamCloudflare.teamId, teamId));
}
