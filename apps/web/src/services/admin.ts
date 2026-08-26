import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  domains,
  emails,
  member,
  organization,
  teamAws,
  teamBilling,
  teamCloudflare,
  teamSettings,
  user,
} from "@/db/schema";
import { recordAudit, type RequestMeta } from "@/lib/audit";
import type { Result } from "@/lib/result";
import { SEND_CONSUMING_STATUS } from "@sendsprite/shared";

/**
 * What the instance operator can see and change, across every team.
 *
 * Every function here assumes `requireInstanceAdmin` has already run — this
 * module has no `next/*` import and does no redirecting, so it is the route's
 * job to gate it, the same split `services/team.ts` uses. What it does own is
 * the *audit*: an instance admin reaching across a tenant boundary is the
 * single most sensitive thing this product allows, and every write below
 * records who did it, to which team, and what changed.
 */

export interface AdminActor {
  userId: string;
  meta?: RequestMeta;
}

/** 30 days of send volume: enough to tell a live team from a dormant one. */
const VOLUME_WINDOW_MS = 30 * 24 * 3600 * 1000;

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  members: number;
  domains: number;
  /** Emails in `SEND_CONSUMING_STATUS` created in the last 30 days. */
  sent30d: number;
  awsConnected: boolean;
  sesStatus: "sandbox" | "requested" | "production" | null;
  cloudflareConnected: boolean;
  plan: string | null;
  suspendedAt: Date | null;
  setupCompleted: boolean;
}

/**
 * Every team, with the handful of facts an operator triages on.
 *
 * The counts are correlated subqueries rather than joins. A team with three
 * domains and forty thousand emails would otherwise produce a hundred and
 * twenty thousand intermediate rows and three wrong counts — the classic
 * fan-out — and `COUNT(DISTINCT …)` only papers over that at a cost that grows
 * with the product of the joins.
 */
export async function listOrganizations(q?: string): Promise<OrgSummary[]> {
  const since = new Date(Date.now() - VOLUME_WINDOW_MS);
  const term = q?.trim();
  const rows = await db()
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdAt: organization.createdAt,
      /*
       * Correlated subqueries built with the query builder, not hand-written
       * `sql` fragments.
       *
       * The `sent30d` fragment used to interpolate `since` — a `Date` — into a
       * raw template, and a raw template runs no column encoder. drizzle hands
       * the value to postgres.js as-is, which expects something already
       * serialised and dies on the object: `The "string" argument must be of
       * type string or an instance of Buffer or ArrayBuffer. Received an
       * instance of Date`. The whole page 500'd. Going through `gte()` applies
       * `timestamp`'s encoder, which is the thing that was missing, and
       * `inArray()` replaces the `sql.join` the array binding needed.
       */
      members: sql<number>`(${db()
        .select({ n: count() })
        .from(member)
        .where(eq(member.organizationId, organization.id))})`,
      domains: sql<number>`(${db()
        .select({ n: count() })
        .from(domains)
        .where(eq(domains.teamId, organization.id))})`,
      sent30d: sql<number>`(${db()
        .select({ n: count() })
        .from(emails)
        .where(
          and(
            eq(emails.teamId, organization.id),
            gte(emails.createdAt, since),
            inArray(emails.status, SEND_CONSUMING_STATUS),
          ),
        )})`,
      sesStatus: teamAws.sesAccountStatus,
      awsTeam: teamAws.teamId,
      cfTeam: teamCloudflare.teamId,
      plan: teamBilling.plan,
      suspendedAt: teamSettings.suspendedAt,
      setupCompleted: teamSettings.setupCompleted,
    })
    .from(organization)
    .leftJoin(teamAws, eq(teamAws.teamId, organization.id))
    .leftJoin(teamCloudflare, eq(teamCloudflare.teamId, organization.id))
    .leftJoin(teamBilling, eq(teamBilling.teamId, organization.id))
    .leftJoin(teamSettings, eq(teamSettings.teamId, organization.id))
    .where(
      term
        ? or(
            ilike(organization.name, `%${term}%`),
            ilike(organization.slug, `%${term}%`),
          )
        : undefined,
    )
    .orderBy(desc(organization.createdAt));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    createdAt: r.createdAt,
    members: Number(r.members ?? 0),
    domains: Number(r.domains ?? 0),
    sent30d: Number(r.sent30d ?? 0),
    awsConnected: r.awsTeam !== null,
    sesStatus: r.sesStatus,
    cloudflareConnected: r.cfTeam !== null,
    plan: r.plan,
    suspendedAt: r.suspendedAt,
    setupCompleted: r.setupCompleted ?? false,
  }));
}

export interface OrgDetail extends OrgSummary {
  dailyLimit: number | null;
  monthlyLimit: number | null;
  retentionDays: number | null;
  suspendedReason: string | null;
  awsAccountId: string | null;
  awsRegion: string | null;
  sesDailyQuota: number | null;
  sesMaxSendRate: number | null;
  cloudflareAccountName: string | null;
  people: {
    userId: string;
    email: string;
    name: string | null;
    role: string;
    instanceAdmin: boolean;
  }[];
}

export async function getOrganization(id: string): Promise<OrgDetail | null> {
  const [base] = await db()
    .select()
    .from(organization)
    .where(eq(organization.id, id))
    .limit(1);
  if (!base) return null;

  const [settings, aws, cf, billing, people, counts] = await Promise.all([
    db()
      .select()
      .from(teamSettings)
      .where(eq(teamSettings.teamId, id))
      .limit(1)
      .then((r) => r[0] ?? null),
    db()
      .select()
      .from(teamAws)
      .where(eq(teamAws.teamId, id))
      .limit(1)
      .then((r) => r[0] ?? null),
    db()
      .select()
      .from(teamCloudflare)
      .where(eq(teamCloudflare.teamId, id))
      .limit(1)
      .then((r) => r[0] ?? null),
    db()
      .select()
      .from(teamBilling)
      .where(eq(teamBilling.teamId, id))
      .limit(1)
      .then((r) => r[0] ?? null),
    db()
      .select({
        userId: member.userId,
        role: member.role,
        email: user.email,
        name: user.name,
        instanceAdmin: user.instanceAdmin,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, id))
      .orderBy(member.createdAt),
    Promise.all([
      db()
        .select({ n: count() })
        .from(domains)
        .where(eq(domains.teamId, id))
        .then((r) => Number(r[0]?.n ?? 0)),
      db()
        .select({ n: count() })
        .from(emails)
        .where(
          and(
            eq(emails.teamId, id),
            gte(emails.createdAt, new Date(Date.now() - VOLUME_WINDOW_MS)),
            inArray(emails.status, SEND_CONSUMING_STATUS),
          ),
        )
        .then((r) => Number(r[0]?.n ?? 0)),
    ]),
  ]);

  return {
    id: base.id,
    name: base.name,
    slug: base.slug,
    createdAt: base.createdAt,
    members: people.length,
    domains: counts[0],
    sent30d: counts[1],
    awsConnected: aws !== null,
    sesStatus: aws?.sesAccountStatus ?? null,
    cloudflareConnected: cf !== null,
    plan: billing?.plan ?? null,
    suspendedAt: settings?.suspendedAt ?? null,
    setupCompleted: settings?.setupCompleted ?? false,
    dailyLimit: settings?.dailyLimit ?? null,
    monthlyLimit: settings?.monthlyLimit ?? null,
    retentionDays: settings?.retentionDays ?? null,
    suspendedReason: settings?.suspendedReason ?? null,
    awsAccountId: aws?.accountId ?? null,
    awsRegion: aws?.region ?? null,
    sesDailyQuota: aws?.sesDailyQuota ?? null,
    sesMaxSendRate: aws?.sesMaxSendRate ?? null,
    cloudflareAccountName: cf?.accountName ?? null,
    people: people.map((p) => ({
      userId: p.userId,
      email: p.email,
      name: p.name,
      role: p.role,
      instanceAdmin: p.instanceAdmin === true,
    })),
  };
}

/**
 * Upserts the operator's per-team overrides.
 *
 * `team_settings` may not have a row yet — a team that never opened the
 * retention form has none — so this is an upsert rather than an update, and it
 * spells every `notNull` column out because Postgres constraint-checks the
 * candidate row *before* it looks for a conflict (the note `team-aws.ts`
 * carries, for the same reason).
 */
export async function setOrgOverrides(
  actor: AdminActor,
  teamId: string,
  patch: {
    dailyLimit: number | null;
    monthlyLimit: number | null;
    retentionDays: number | null;
  },
): Promise<Result> {
  const [before] = await db()
    .select({
      dailyLimit: teamSettings.dailyLimit,
      monthlyLimit: teamSettings.monthlyLimit,
      retentionDays: teamSettings.retentionDays,
    })
    .from(teamSettings)
    .where(eq(teamSettings.teamId, teamId))
    .limit(1);

  if (before) {
    await db()
      .update(teamSettings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(teamSettings.teamId, teamId));
  } else {
    await db()
      .insert(teamSettings)
      .values({ teamId, ...patch, updatedAt: new Date() });
  }

  await recordAudit({
    teamId,
    actorUserId: actor.userId,
    action: "admin.team.overrides",
    targetType: "team",
    targetId: teamId,
    diff: {
      dailyLimit: { from: before?.dailyLimit ?? null, to: patch.dailyLimit },
      monthlyLimit: {
        from: before?.monthlyLimit ?? null,
        to: patch.monthlyLimit,
      },
      retentionDays: {
        from: before?.retentionDays ?? null,
        to: patch.retentionDays,
      },
    },
    ...actor.meta,
  });
  return { ok: true, data: undefined };
}

/** Suspends or restores a team's ability to send. See `checkTeamCaps`. */
export async function setOrgSuspended(
  actor: AdminActor,
  teamId: string,
  suspended: boolean,
  reason: string | null,
): Promise<Result> {
  const at = suspended ? new Date() : null;
  const [existing] = await db()
    .select({ at: teamSettings.suspendedAt })
    .from(teamSettings)
    .where(eq(teamSettings.teamId, teamId))
    .limit(1);
  if (existing !== undefined) {
    await db()
      .update(teamSettings)
      .set({
        suspendedAt: at,
        suspendedReason: suspended ? reason : null,
        updatedAt: new Date(),
      })
      .where(eq(teamSettings.teamId, teamId));
  } else {
    await db()
      .insert(teamSettings)
      .values({
        teamId,
        suspendedAt: at,
        suspendedReason: suspended ? reason : null,
        updatedAt: new Date(),
      });
  }
  await recordAudit({
    teamId,
    actorUserId: actor.userId,
    action: suspended ? "admin.team.suspend" : "admin.team.unsuspend",
    targetType: "team",
    targetId: teamId,
    diff: { reason: { to: suspended ? reason : null } },
    ...actor.meta,
  });
  return { ok: true, data: undefined };
}

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  instanceAdmin: boolean;
  createdAt: Date;
  teams: number;
}

export async function listUsers(q?: string): Promise<UserRow[]> {
  const term = q?.trim();
  const rows = await db()
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      instanceAdmin: user.instanceAdmin,
      createdAt: user.createdAt,
      teams: sql<number>`(select count(*) from ${member} where ${member.userId} = ${user.id})`,
    })
    .from(user)
    .where(
      term
        ? or(ilike(user.email, `%${term}%`), ilike(user.name, `%${term}%`))
        : undefined,
    )
    .orderBy(desc(user.createdAt));
  return rows.map((r) => ({
    ...r,
    instanceAdmin: r.instanceAdmin === true,
    teams: Number(r.teams ?? 0),
  }));
}

/**
 * Grants or removes the instance-admin flag.
 *
 * Refuses to remove the **last** flagged admin, and only counts the column —
 * not `INSTANCE_ADMIN_EMAILS`. That is deliberate: the env allowlist is the
 * lock-out recovery path, and treating it as a reason to allow the last
 * database admin to be removed would mean the safety net has to be correct
 * for the removal to be safe. Someone with shell access can always set the env
 * var; someone without it should not be able to leave `/admin` unreachable.
 */
export async function setInstanceAdmin(
  actor: AdminActor,
  userId: string,
  value: boolean,
): Promise<Result> {
  if (!value) {
    if (userId === actor.userId)
      return {
        ok: false,
        error:
          "You cannot remove your own instance-admin flag. Ask another admin to do it.",
      };
    const [{ n } = { n: 0 }] = await db()
      .select({ n: count() })
      .from(user)
      .where(eq(user.instanceAdmin, true));
    if (Number(n) <= 1)
      return {
        ok: false,
        error:
          "This is the last instance admin. Promote someone else before removing this one.",
      };
  }
  const [target] = await db()
    .select({ email: user.email, was: user.instanceAdmin })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!target) return { ok: false, error: "No such user." };

  await db()
    .update(user)
    .set({ instanceAdmin: value })
    .where(eq(user.id, userId));
  await recordAudit({
    teamId: null,
    actorUserId: actor.userId,
    action: "admin.user.instanceAdmin",
    targetType: "user",
    targetId: userId,
    diff: {
      email: { to: target.email },
      instanceAdmin: { from: target.was === true, to: value },
    },
    ...actor.meta,
  });
  return { ok: true, data: undefined };
}

export interface InstanceStats {
  teams: number;
  users: number;
  domains: number;
  sent30d: number;
  suspended: number;
  awsConnected: number;
}

export async function instanceStats(): Promise<InstanceStats> {
  const since = new Date(Date.now() - VOLUME_WINDOW_MS);
  const one = async (q: Promise<{ n: number }[]>) =>
    Number((await q)[0]?.n ?? 0);
  const [teams, users, domainCount, sent30d, suspended, awsConnected] =
    await Promise.all([
      one(db().select({ n: count() }).from(organization)),
      one(db().select({ n: count() }).from(user)),
      one(db().select({ n: count() }).from(domains)),
      one(
        db()
          .select({ n: count() })
          .from(emails)
          .where(
            and(
              gte(emails.createdAt, since),
              inArray(emails.status, SEND_CONSUMING_STATUS),
            ),
          ),
      ),
      one(
        db()
          .select({ n: count() })
          .from(teamSettings)
          .where(sql`${teamSettings.suspendedAt} is not null`),
      ),
      one(db().select({ n: count() }).from(teamAws)),
    ]);
  return {
    teams,
    users,
    domains: domainCount,
    sent30d,
    suspended,
    awsConnected,
  };
}
