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
  session,
  teamAssets,
  teamAws,
  teamBilling,
  teamCloudflare,
  teamSettings,
  user,
} from "@/db/schema";
import { recordAudit, type RequestMeta } from "@/lib/audit";
import { pgCode } from "@/lib/pg";
import type { Result } from "@/lib/result";
import {
  isGrantedPlan,
  SEND_CONSUMING_STATUS,
  type GrantedPlan,
} from "@sendsprite/shared";

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
  /** The operator's plan grant, when one is in force. It beats `plan`. */
  planOverride: string | null;
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
      planOverride: teamSettings.planOverride,
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
    planOverride: r.planOverride,
    suspendedAt: r.suspendedAt,
    setupCompleted: r.setupCompleted ?? false,
  }));
}

export interface OrgDetail extends OrgSummary {
  /**
   * The same grant as `planOverride`, with the operator who made it — resolved
   * to their email, since a user id tells the reader nothing — and when. `by`
   * is null where that account has since been deleted; `at` is not optional
   * because `team_settings_plan_override_complete` will not let a grant exist
   * without one. The list needs only the plan name, which is why the summary
   * carries it and this does not repeat the lookup.
   */
  planGrant: { plan: string; by: string | null; at: Date } | null;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  retentionDays: number | null;
  suspendedReason: string | null;
  awsAccountId: string | null;
  awsRegion: string | null;
  sesDailyQuota: number | null;
  sesMaxSendRate: number | null;
  cloudflareAccountName: string | null;
  /**
   * Images uploaded through the editor. Each is at most 2 MB, deduplicated
   * per team by content hash, and never purged — delivered mail keeps
   * fetching them — so this is the one number on the page that only grows.
   * It is here so the growth is visible before it is a surprise; there is no
   * cap, which is a decision for whoever hosts this, not a default.
   */
  assets: { count: number; bytes: number };
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
      db()
        .select({
          n: count(),
          bytes: sql<string>`coalesce(sum(${teamAssets.size}), 0)`,
        })
        .from(teamAssets)
        .where(eq(teamAssets.teamId, id))
        .then((r) => ({
          count: Number(r[0]?.n ?? 0),
          bytes: Number(r[0]?.bytes ?? 0),
        })),
    ]),
  ]);

  /*
   * A second round trip rather than a join, because it happens only for the
   * few teams that actually carry a grant. `plan_override_by` has no foreign
   * key — the audit trail must outlive the account, the same reason
   * `audit_log` has none — so a deleted operator resolves to null here rather
   * than dropping the grant from the page.
   */
  const grantedBy = settings?.planOverrideBy
    ? ((
        await db()
          .select({ email: user.email })
          .from(user)
          .where(eq(user.id, settings.planOverrideBy))
          .limit(1)
      )[0]?.email ?? null)
    : null;

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
    planOverride: settings?.planOverride ?? null,
    // The `&& planOverrideAt` is the type system catching up with the CHECK
    // constraint, not a real branch: a row cannot hold one without the other.
    planGrant:
      settings?.planOverride && settings.planOverrideAt
        ? {
            plan: settings.planOverride,
            by: grantedBy,
            at: settings.planOverrideAt,
          }
        : null,
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
    assets: counts[2],
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
 * Writes the operator's per-team overrides: the numeric caps and the plan grant.
 *
 * Reads the row first, then updates or inserts. The read is not just an
 * existence check — the previous values are what the audit diff is built from,
 * and comparing the old plan to the new one is what decides whether the grant
 * columns move at all. `team_settings` may genuinely have no row yet: a team
 * that never opened its own settings has none.
 */
export async function setOrgOverrides(
  actor: AdminActor,
  teamId: string,
  patch: {
    dailyLimit: number | null;
    monthlyLimit: number | null;
    retentionDays: number | null;
    /** A plan name from `GRANTABLE_PLANS`, or null to drop the grant. */
    planOverride: string | null;
  },
): Promise<Result> {
  // Checked here rather than only in the action: the plan name goes into a
  // text column and is read back as an entitlement, so an unknown value would
  // silently resolve to Free for whoever the operator meant to help.
  if (patch.planOverride !== null && !isGrantedPlan(patch.planOverride))
    return { ok: false, error: `Unknown plan "${patch.planOverride}".` };
  const plan: GrantedPlan | null = patch.planOverride;

  const [before] = await db()
    .select({
      dailyLimit: teamSettings.dailyLimit,
      monthlyLimit: teamSettings.monthlyLimit,
      retentionDays: teamSettings.retentionDays,
      planOverride: teamSettings.planOverride,
    })
    .from(teamSettings)
    .where(eq(teamSettings.teamId, teamId))
    .limit(1);

  /*
   * The three grant columns move together or not at all —
   * `team_settings_plan_override_complete` refuses any other combination — so
   * they are written in the same statement as the limits. Leaving them out
   * when the plan has not changed is what keeps `plan_override_at` meaning
   * "when this grant was made" rather than "when the retention field was last
   * saved".
   */
  const grantChanged = (before?.planOverride ?? null) !== plan;
  const grant = !grantChanged
    ? {}
    : plan === null
      ? { planOverride: null, planOverrideBy: null, planOverrideAt: null }
      : {
          planOverride: plan,
          planOverrideBy: actor.userId,
          planOverrideAt: new Date(),
        };
  const values = {
    dailyLimit: patch.dailyLimit,
    monthlyLimit: patch.monthlyLimit,
    retentionDays: patch.retentionDays,
    ...grant,
    updatedAt: new Date(),
  };

  if (before) {
    await db()
      .update(teamSettings)
      .set(values)
      .where(eq(teamSettings.teamId, teamId));
  } else {
    await db()
      .insert(teamSettings)
      .values({ teamId, ...values });
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
  // A separate entry from the limits above, and only when the plan moved: a
  // grant is the one override that changes what a team is *sold*, and it
  // should be findable by its own action name rather than buried in a diff
  // alongside a retention tweak.
  if (grantChanged)
    await recordAudit({
      teamId,
      actorUserId: actor.userId,
      action: "admin.team.plan_override",
      targetType: "team",
      targetId: teamId,
      diff: { plan: { from: before?.planOverride ?? null, to: plan } },
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
  bannedAt: Date | null;
  bannedReason: string | null;
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
      bannedAt: user.bannedAt,
      bannedReason: user.bannedReason,
      // Built with the query builder, like `listOrganizations` above, and
      // for a subtler reason than that one. A hand-written fragment
      // `${member.userId} = ${user.id}` rendered as `"user_id" = "id"`:
      // drizzle leaves column references unqualified when the outer query
      // has a single table, and inside the subquery `"id"` is `member.id`.
      // The count was 0 for every user on the instance, and the users table
      // said so for as long as it existed. `eq()` in a nested select renders
      // both sides qualified.
      teams: sql<number>`(${db()
        .select({ n: count() })
        .from(member)
        .where(eq(member.userId, user.id))})`,
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

/**
 * Locks an account out of the dashboard, or lets it back in.
 *
 * A ban is about the person, not their teams. A banned owner cannot sign in;
 * their team's API keys keep sending, because stopping a customer's mail is
 * `setOrgSuspended` and is a different decision with its own audit entry and
 * its own error message to the customer. An operator who means both does both.
 *
 * Their sessions are deleted rather than left to expire: a ban that takes
 * effect at the next login is not a ban.
 */
export async function setUserBanned(
  actor: AdminActor,
  userId: string,
  banned: boolean,
  reason: string | null,
): Promise<Result> {
  if (banned && userId === actor.userId)
    return {
      ok: false,
      error: "You cannot ban yourself.",
    };

  const [target] = await db()
    .select({
      email: user.email,
      was: user.bannedAt,
      admin: user.instanceAdmin,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!target) return { ok: false, error: "No such user." };
  if (banned && target.admin === true)
    return {
      ok: false,
      error:
        "This user is an instance admin. Remove the flag first — banning an operator out of the surface that unbans them is not recoverable from here.",
    };

  const at = banned ? new Date() : null;
  const trimmed = banned ? (reason?.trim() ?? "") : "";
  await db()
    .update(user)
    .set({ bannedAt: at, bannedReason: trimmed.length > 0 ? trimmed : null })
    .where(eq(user.id, userId));
  if (banned) await db().delete(session).where(eq(session.userId, userId));

  await recordAudit({
    teamId: null,
    actorUserId: actor.userId,
    action: banned ? "admin.user.ban" : "admin.user.unban",
    targetType: "user",
    targetId: userId,
    diff: {
      email: { to: target.email },
      banned: { from: target.was !== null, to: banned },
      ...(banned && trimmed ? { reason: { to: trimmed } } : {}),
    },
    ...actor.meta,
  });
  return { ok: true, data: undefined };
}

/**
 * Renames a team, as its operator rather than as its owner.
 *
 * The slug is part of it because the slug is what a team is addressed by, and
 * an operator renaming "acme" to "acme-old" to free the name is the reason
 * this exists. Uniqueness is the database's to enforce; a clash comes back as
 * a message rather than a 500.
 */
export async function renameOrganization(
  actor: AdminActor,
  teamId: string,
  patch: { name: string; slug: string },
): Promise<Result> {
  const name = patch.name.trim();
  const slug = patch.slug.trim().toLowerCase();
  if (name.length === 0) return { ok: false, error: "A name is required." };
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug))
    return {
      ok: false,
      error:
        "A slug is lower-case letters, digits and dashes, starting with a letter or digit, up to 48 characters.",
    };

  const [before] = await db()
    .select({ name: organization.name, slug: organization.slug })
    .from(organization)
    .where(eq(organization.id, teamId))
    .limit(1);
  if (!before) return { ok: false, error: "No such team." };

  try {
    await db()
      .update(organization)
      .set({ name, slug })
      .where(eq(organization.id, teamId));
  } catch (e) {
    if (pgCode(e) === "23505")
      return { ok: false, error: `The slug "${slug}" is already taken.` };
    throw e;
  }

  await recordAudit({
    teamId,
    actorUserId: actor.userId,
    action: "admin.team.rename",
    targetType: "team",
    targetId: teamId,
    diff: {
      name: { from: before.name, to: name },
      slug: { from: before.slug, to: slug },
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
