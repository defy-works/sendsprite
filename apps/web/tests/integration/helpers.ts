import { randomBytes } from "node:crypto";
import { db } from "@/db";
import { createApiKey, type ApiKeyPermission } from "@/services/api-keys";

/**
 * A fresh team with one API key (`full` unless told otherwise) in the
 * database `startPg()` booted for this file. Ids are random so a test can
 * call it more than once. `APP_SECRET` must be set (the key is hashed).
 */
export async function seedTeamWithKey({
  permission = "full",
}: { permission?: ApiKeyPermission } = {}) {
  const suffix = randomBytes(4).toString("hex");
  const team = { id: `org_${suffix}`, name: `Team ${suffix}`, slug: suffix };
  await db().execute(
    `insert into "organization"(id,name,slug,created_at) values ('${team.id}','${team.name}','${team.slug}',now())`,
  );
  const actor = {
    userId: `u_${suffix}`,
    teamId: team.id,
    teamName: team.name,
    role: "owner" as const,
  };
  const res = await createApiKey(actor, { name: "seed", permission });
  if (!res.ok) throw new Error(`seed failed: ${res.error}`);
  return {
    team,
    key: { id: res.data.id, permission },
    secret: res.data.secret,
  };
}
