import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { teamAws } from "@/db/schema";
import { computeDiff, recordAudit, type RequestMeta } from "@/lib/audit";
import { getCipher } from "@/lib/crypto";

export type TeamAws = typeof teamAws.$inferSelect;

/** Who is changing a team's AWS connection. */
export interface AwsActor {
  userId: string;
  meta?: RequestMeta;
}

async function selectRow(teamId: string) {
  const [row] = await db()
    .select()
    .from(teamAws)
    .where(eq(teamAws.teamId, teamId))
    .limit(1);
  return row ?? null;
}

/**
 * Null means this team has not connected AWS — the row's existence *is* the
 * connection, which is what replaced the old `aws_mode = "none"`.
 *
 * Request-scoped (`React.cache`) so a layout and its page share one query.
 * The cache is keyed per argument and lives for the request, so a read taken
 * after a write in the same request returns the pre-write row; every writer
 * here returns the fresh row instead of re-reading.
 */
export const getTeamAws = cache(
  async (teamId: string): Promise<TeamAws | null> => selectRow(teamId),
);

/** Plain columns only: the key columns are written through `Secrets`. */
type Plain = Partial<
  Omit<
    TeamAws,
    "teamId" | "createdAt" | "updatedAt" | "accessKeyEnc" | "secretEnc"
  >
>;
type Secrets = { accessKey?: string; secret?: string };

/**
 * Row as it appears in the audit diff: bookkeeping columns dropped. Secret
 * columns are compared as ciphertext so a rotation (set → set) still shows
 * up; `computeDiff` redacts them by key name, so the plaintext never reaches
 * the log.
 */
function auditView(row: TeamAws | null): Record<string, unknown> {
  if (!row) return {};
  const view: Record<string, unknown> = { ...row };
  for (const col of ["teamId", "createdAt", "updatedAt"]) delete view[col];
  return view;
}

/** The columns an insert cannot omit; a patch on a live row may. */
const REQUIRED = [
  "region",
  "accessKeyEnc",
  "secretEnc",
  "configSet",
  "connectedAt",
] as const;

/**
 * Write one team's connection: an INSERT when the team has no row, an UPDATE
 * when it has.
 *
 * Deliberately **not** `INSERT … ON CONFLICT DO UPDATE`. Postgres builds and
 * constraint-checks the candidate row before it looks for a conflict, so an
 * upsert carrying only `{ snsSubscriptionArn }` fails on `region` being NULL
 * even though the row it means to touch already exists and has one.
 *
 * Writes a team-scoped audit row unless `opts.audit` is false (bookkeeping
 * writes such as `sesLastCheckedAt`); `opts.action` names it so
 * connect/disconnect read as events rather than diffs.
 */
export async function updateTeamAws(
  teamId: string,
  patch: Plain & Secrets,
  actor?: AwsActor,
  opts: { audit?: boolean; action?: string } = {},
): Promise<TeamAws> {
  const before = await selectRow(teamId);
  const { accessKey, secret, ...plain } = patch;
  const c = getCipher();
  const enc = {
    ...(accessKey !== undefined && { accessKeyEnc: c.encrypt(accessKey) }),
    ...(secret !== undefined && { secretEnc: c.encrypt(secret) }),
  };
  const set = { ...plain, ...enc, updatedAt: new Date() };
  let row: TeamAws | undefined;
  if (before) {
    [row] = await db()
      .update(teamAws)
      .set(set)
      .where(eq(teamAws.teamId, teamId))
      .returning();
  } else {
    const missing = REQUIRED.filter(
      (k) => (set as Record<string, unknown>)[k] == null,
    );
    if (missing.length > 0)
      throw new Error(
        `team_aws insert for ${teamId} is missing ${missing.join(", ")}`,
      );
    [row] = await db()
      .insert(teamAws)
      .values({ teamId, ...(set as typeof teamAws.$inferInsert) })
      .returning();
  }
  if (!row) throw new Error("team_aws write returned no row");
  if (opts.audit === false) return row;
  await recordAudit({
    teamId,
    actorUserId: actor?.userId ?? null,
    action: opts.action ?? "aws.update",
    targetType: "team_aws",
    targetId: teamId,
    diff: computeDiff(auditView(before), auditView(row)),
    ...actor?.meta,
  });
  return row;
}

/** Null when the team has no connection; never partially decrypted. */
export async function getTeamAwsSecrets(
  teamId: string,
): Promise<{ accessKey: string; secret: string } | null> {
  const row = await selectRow(teamId);
  if (!row) return null;
  const c = getCipher();
  return {
    accessKey: c.decrypt(row.accessKeyEnc),
    secret: c.decrypt(row.secretEnc),
  };
}

/** Disconnecting is a row delete: existence of the row is the connection. */
export async function disconnectTeamAws(
  teamId: string,
  actor?: AwsActor,
): Promise<void> {
  const before = await selectRow(teamId);
  if (!before) return;
  await db().delete(teamAws).where(eq(teamAws.teamId, teamId));
  await recordAudit({
    teamId,
    actorUserId: actor?.userId ?? null,
    action: "aws.disconnect",
    targetType: "team_aws",
    targetId: teamId,
    diff: computeDiff(auditView(before), {}),
    ...actor?.meta,
  });
}
