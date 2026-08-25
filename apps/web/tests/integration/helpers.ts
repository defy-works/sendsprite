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
