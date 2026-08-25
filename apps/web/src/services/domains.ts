import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
} from "@aws-sdk/client-sesv2";
import { can, newId } from "@sendsprite/shared";
import { db } from "@/db";
import { domains } from "@/db/schema";
import { makeSes } from "@/lib/aws/clients";
import { resolveAwsContext } from "@/lib/aws/credentials";
import type { FetchLike } from "@/lib/cloudflare/client";
import { expectedRecords } from "@/lib/dns/records";
import { matchZone } from "@/lib/dns/zone-match";
import { checkRecords, type Resolver } from "@/lib/dns/check";
import { recordAudit } from "@/lib/audit";
import type { Result } from "@/lib/result";
import { getInstanceSettings } from "./instance-settings";
import { cloudflareClient, listZones } from "./cloudflare-connect";
import type { TeamActor } from "./team";

export type Domain = typeof domains.$inferSelect;

/**
 * `startAfter` is a delay in seconds (pg-boss casts a number to an interval).
 * `singletonKey` dedups on a queue with a policy that enforces it: the
 * `domain.verify` queue is `exclusive`, so one verify job per domain can be
 * created/retry/active at a time and a duplicate send is dropped (null).
 * Resolves to the job id, or null when deduped.
 */
export type Enqueue = (
  queue: string,
  data: object,
  opts?: { startAfter?: number; singletonKey?: string },
) => Promise<unknown>;

/** Injection points: the job queue, Cloudflare's fetch, and the DNS resolver. */
interface Deps {
  enqueue: Enqueue;
  fetch?: FetchLike;
  resolver?: Resolver;
}

/**
 * A pending domain is re-checked by the `domain.verify-sweep` cron (every
 * 2 minutes; see jobs/handlers/domain-verify.ts) for 72 hours before it
 * fails. The sweep skips rows checked within SWEEP_STALE_S so a tick never
 * re-runs a check the previous tick just finished.
 */
const SWEEP_STALE_S = 100;
const FIRST_VERIFY_AFTER_S = 30;
const VERIFY_WINDOW_MS = 72 * 3600 * 1000;
const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DENIED: Result<never> = {
  ok: false,
  error: "You don't have permission to do that.",
};
const DUPLICATE: Result<never> = {
  ok: false,
  code: "conflict",
  error: "That domain is already added on this instance.",
};
const NOT_FOUND: Result<never> = {
  ok: false,
  code: "not_found",
  error: "Domain not found.",
};
const CF_DISCONNECTED =
  "Cloudflare is not connected; add the records manually.";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errName = (e: unknown) =>
  typeof e === "object" && e !== null
    ? (e as { name?: string }).name
    : undefined;
/** Postgres SQLSTATE, on the driver error or (drizzle) its `cause`. */
const pgCode = (e: unknown): string | undefined => {
  const o = e as { code?: string; cause?: { code?: string } } | null;
  return o?.code ?? o?.cause?.code;
};

export async function listDomains(teamId: string): Promise<Domain[]> {
  return db()
    .select()
    .from(domains)
    .where(eq(domains.teamId, teamId))
    .orderBy(domains.createdAt);
}

export async function getDomain(
  teamId: string,
  id: string,
): Promise<Domain | null> {
  const [d] = await db()
    .select()
    .from(domains)
    .where(and(eq(domains.id, id), eq(domains.teamId, teamId)))
    .limit(1);
  return d ?? null;
}

async function loadById(id: string): Promise<Domain | undefined> {
  const [d] = await db()
    .select()
    .from(domains)
    .where(eq(domains.id, id))
    .limit(1);
  return d;
}

function enqueueVerify(enqueue: Enqueue, domainId: string, startAfter = 0) {
  return enqueue(
    "domain.verify",
    { domainId },
    { startAfter, singletonKey: domainId },
  );
}

/**
 * Add a sending domain. Picks `auto` DNS mode when a connected Cloudflare
 * zone covers the name, `manual` otherwise, then queues provisioning.
 */
export async function createDomain(
  actor: TeamActor,
  input: unknown,
  deps: Deps,
): Promise<Result<Domain>> {
  if (!can(actor.role, "domains.manage")) return DENIED;
  const parsed = z
    .object({
      name: z
        .string()
        .transform((s) => s.trim().toLowerCase().replace(/\.$/, "")),
    })
    .safeParse(input);
  if (!parsed.success || !DOMAIN_RE.test(parsed.data.name))
    return { ok: false, error: "Enter a valid domain like mail.example.com." };
  const name = parsed.data.name;
  const settings = await getInstanceSettings();
  if (settings.awsMode === "none" || !settings.awsRegion)
    return { ok: false, error: "Connect AWS first (Settings → Instance)." };
  const [dupe] = await db()
    .select({ id: domains.id })
    .from(domains)
    .where(eq(domains.name, name))
    .limit(1);
  if (dupe) return DUPLICATE;
  const zone = matchZone(name, await listZones(deps.fetch));
  const id = newId("dom");
  let row: Domain | undefined;
  try {
    [row] = await db()
      .insert(domains)
      .values({
        id,
        teamId: actor.teamId,
        name,
        region: settings.awsRegion,
        cloudflareZoneId: zone?.id ?? null,
        dnsMode: zone ? "auto" : "manual",
        mailFromDomain: `bounce.${name}`,
        verifyUntil: new Date(Date.now() + VERIFY_WINDOW_MS),
        createdBy: actor.userId,
      })
      .returning();
  } catch (e) {
    // Two concurrent adds of the same name: the unique index decides.
    if (pgCode(e) === "23505") return DUPLICATE;
    throw e;
  }
  if (!row) throw new Error("domains insert returned no row");
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "domains.create",
    targetType: "domain",
    targetId: id,
    diff: { name: { to: name }, dnsMode: { to: row.dnsMode } },
    ...actor.meta,
  });
  // The queue can be unreachable (pg-boss down, schema missing) while the
  // row is already there; keep the domain and surface the problem on it so
  // "Retry provisioning" can re-send instead of the user re-adding.
  try {
    await deps.enqueue("domain.provision", { domainId: id });
  } catch (e) {
    const lastError = `Could not queue provisioning: ${errMsg(e)}`;
    [row] = await db()
      .update(domains)
      .set({ lastError })
      .where(eq(domains.id, id))
      .returning();
    if (!row) throw new Error("domains update returned no row");
    console.error(`[domains] ${lastError}`);
  }
  return { ok: true, data: row };
}

/**
 * Re-send `domain.provision` for a domain whose provisioning never ran
 * (queue failure at create time) or failed terminally. Refused once the
 * identity exists (tokens stored): Re-verify covers that case.
 */
export async function retryProvisioning(
  actor: TeamActor,
  id: string,
  deps: Pick<Deps, "enqueue">,
): Promise<Result> {
  if (!can(actor.role, "domains.manage")) return DENIED;
  const d = await getDomain(actor.teamId, id);
  if (!d) return NOT_FOUND;
  if (d.dkimTokens.length > 0)
    return { ok: false, error: "This domain is already provisioned." };
  await db()
    .update(domains)
    .set({
      status: "pending",
      lastError: null,
      verifyUntil: new Date(Date.now() + VERIFY_WINDOW_MS),
    })
    .where(eq(domains.id, id));
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "domains.retry_provisioning",
    targetType: "domain",
    targetId: id,
    diff: { status: { from: d.status, to: "pending" } },
    ...actor.meta,
  });
  try {
    await deps.enqueue("domain.provision", { domainId: id });
  } catch (e) {
    const lastError = `Could not queue provisioning: ${errMsg(e)}`;
    await db().update(domains).set({ lastError }).where(eq(domains.id, id));
    return { ok: false, error: lastError };
  }
  return { ok: true, data: undefined };
}

/**
 * Job: SES identity + MAIL FROM + (auto mode) Cloudflare records, then
 * schedule the first verification. Idempotent: an existing identity is
 * read back for its tokens and Cloudflare upserts by (type, name[, content]).
 * The tokens and expected records are persisted before the Cloudflare loop
 * and each record's `cloudflareId` right after its upsert, so a failure
 * mid-loop leaves the ids already created on the row (delete removes them;
 * the retry patches instead of duplicating). Auto mode with Cloudflare
 * disconnected degrades to manual (records are still computed for the user
 * to add by hand). Throws after recording
 * `lastError` so pg-boss retries; on the handler's `finalAttempt` the
 * domain is also marked `failed` (no more retries are coming).
 */
export async function provisionDomain(
  domainId: string,
  deps: Deps,
  { finalAttempt = false }: { finalAttempt?: boolean } = {},
): Promise<void> {
  const d = await loadById(domainId);
  if (!d) return;
  try {
    const ses = makeSes(await resolveAwsContext());
    const settings = await getInstanceSettings();
    const identity = await ses
      .send(
        new CreateEmailIdentityCommand({
          EmailIdentity: d.name,
          ConfigurationSetName: settings.sesConfigSet ?? undefined,
          DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
        }),
      )
      .catch((e: unknown) => {
        if (errName(e) !== "AlreadyExistsException") throw e;
        return ses.send(new GetEmailIdentityCommand({ EmailIdentity: d.name }));
      });
    const tokens = identity.DkimAttributes?.Tokens ?? [];
    await ses.send(
      new PutEmailIdentityMailFromAttributesCommand({
        EmailIdentity: d.name,
        MailFromDomain: d.mailFromDomain,
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
      }),
    );
    const recs = expectedRecords({
      domain: d.name,
      region: d.region,
      dkimTokens: tokens,
      mailFromDomain: d.mailFromDomain,
    });
    const persistRecords = () =>
      db()
        .update(domains)
        .set({ expectedRecords: [...recs] })
        .where(eq(domains.id, d.id));
    await db()
      .update(domains)
      .set({
        dkimTokens: tokens,
        dkimStatus: identity.DkimAttributes?.Status ?? null,
        expectedRecords: [...recs],
      })
      .where(eq(domains.id, d.id));
    let dnsMode = d.dnsMode;
    let lastError: string | null = null;
    if (d.dnsMode === "auto" && d.cloudflareZoneId) {
      const zoneId = d.cloudflareZoneId;
      const cf = await cloudflareClient(deps.fetch);
      if (cf) {
        for (const r of recs) {
          const { id } = await cf.upsertRecord(zoneId, {
            type: r.type,
            name: r.name,
            content: r.value,
            priority: r.priority,
          });
          r.cloudflareId = id;
          await persistRecords();
        }
      } else {
        dnsMode = "manual";
        lastError = CF_DISCONNECTED;
      }
    }
    await db()
      .update(domains)
      .set({ dnsMode, lastError })
      .where(eq(domains.id, d.id));
    await enqueueVerify(deps.enqueue, d.id, FIRST_VERIFY_AFTER_S);
  } catch (e) {
    await db()
      .update(domains)
      .set({
        lastError: errMsg(e),
        ...(finalAttempt && { status: "failed" as const }),
      })
      .where(eq(domains.id, d.id));
    throw e;
  }
}

async function setError(id: string, lastError: string) {
  await db()
    .update(domains)
    .set({ lastError, lastCheckedAt: new Date() })
    .where(eq(domains.id, id));
}

/**
 * Job: poll SES + DNS once. Verified → done; pending → left for the next
 * sweep; past the window → failed. It never re-enqueues itself: the
 * `domain.verify-sweep` cron picks pending rows by `lastCheckedAt`, which
 * every outcome below bumps. AWS disconnected sets `lastError` and leaves
 * the status (the sweep keeps trying once per tick until reconnect or
 * Re-verify); the SES identity gone is `failed` (the user deletes and
 * re-adds). Any other SES error records `lastError` and rethrows so
 * pg-boss retries. A verified domain is a no-op unless `force` (Re-verify):
 * then it stays verified while SES still agrees and is demoted to pending
 * only when SES reports DKIM or MAIL FROM as no longer SUCCESS.
 */
export async function verifyDomain(
  domainId: string,
  deps: Pick<Deps, "resolver"> = {},
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  const d = await loadById(domainId);
  if (!d || (d.status === "verified" && !force)) return;
  let ses;
  try {
    ses = makeSes(await resolveAwsContext());
  } catch (e) {
    await setError(d.id, errMsg(e));
    return;
  }
  let ident;
  try {
    ident = await ses.send(
      new GetEmailIdentityCommand({ EmailIdentity: d.name }),
    );
  } catch (e) {
    if (errName(e) === "NotFoundException") {
      await db()
        .update(domains)
        .set({
          status: "failed",
          lastCheckedAt: new Date(),
          lastError: "SES identity was removed; delete and re-add the domain.",
        })
        .where(eq(domains.id, d.id));
      return;
    }
    await setError(d.id, errMsg(e));
    throw e;
  }
  const recs = await checkRecords(d.expectedRecords, deps.resolver);
  const dkimOk = ident.DkimAttributes?.Status === "SUCCESS";
  const mailFromOk =
    ident.MailFromAttributes?.MailFromDomainStatus === "SUCCESS";
  const spfOk = recs.some((r) => r.kind === "MAIL_FROM_SPF" && r.ok);
  const dmarcOk = recs.some((r) => r.kind === "DMARC" && r.ok);
  // SES is the authority on sending; SPF/DMARC are advisory and shown per-record.
  const verified = dkimOk && mailFromOk;
  const expired =
    !verified && !!d.verifyUntil && d.verifyUntil.getTime() < Date.now();
  await db()
    .update(domains)
    .set({
      expectedRecords: recs,
      dkimStatus: ident.DkimAttributes?.Status ?? null,
      mailFromStatus: ident.MailFromAttributes?.MailFromDomainStatus ?? null,
      spfOk,
      dmarcOk,
      lastCheckedAt: new Date(),
      status: verified ? "verified" : expired ? "failed" : "pending",
      verifiedAt: verified ? (d.verifiedAt ?? new Date()) : null,
      lastError: expired
        ? "Verification timed out after 72 hours. Check the records and click Re-verify."
        : null,
    })
    .where(eq(domains.id, d.id));
}

/**
 * Domains the verification sweep should enqueue: pending, provisioned
 * (tokens stored), and not checked within the last SWEEP_STALE_S. Rows past
 * `verifyUntil` are included on purpose: the next check marks them `failed`.
 */
export async function selectSweepCandidates(): Promise<string[]> {
  const rows = await db()
    .select({ id: domains.id })
    .from(domains)
    .where(
      and(
        eq(domains.status, "pending"),
        sql`${domains.dkimTokens} != '[]'::jsonb`,
        or(
          isNull(domains.lastCheckedAt),
          lt(
            domains.lastCheckedAt,
            sql`now() - make_interval(secs => ${SWEEP_STALE_S})`,
          ),
        ),
      ),
    )
    .orderBy(domains.createdAt);
  return rows.map((r) => r.id);
}

/**
 * Manual "Re-verify": resets the window and runs one forced check inline so
 * the click answers right away; while the domain stays pending the sweep
 * keeps checking it. A verified domain is not demoted up front: it keeps
 * its status (and `verifiedAt`) unless the check finds SES disagreeing; a
 * failed one goes back to pending so the check can decide.
 */
export async function reverifyDomain(
  actor: TeamActor,
  id: string,
  deps: Pick<Deps, "resolver"> = {},
): Promise<Result> {
  if (!can(actor.role, "domains.manage")) return DENIED;
  const d = await getDomain(actor.teamId, id);
  if (!d) return NOT_FOUND;
  // Before provisioning there is no identity to check; the job will verify.
  if (d.dkimTokens.length === 0)
    return { ok: false, error: "Provisioning hasn't finished yet." };
  const status = d.status === "failed" ? "pending" : d.status;
  await db()
    .update(domains)
    .set({
      status,
      verifyUntil: new Date(Date.now() + VERIFY_WINDOW_MS),
      lastError: null,
    })
    .where(eq(domains.id, id));
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "domains.reverify",
    targetType: "domain",
    targetId: id,
    diff: { status: { from: d.status, to: status } },
    ...actor.meta,
  });
  try {
    await verifyDomain(id, deps, { force: true });
  } catch (e) {
    return { ok: false, error: `Check failed: ${errMsg(e)}` };
  }
  return { ok: true, data: undefined };
}

export interface DeleteOutcome {
  /** Cloudflare records we created but could not remove (0 in manual mode). */
  leftoverDnsRecords: number;
}

/**
 * Remove the SES identity and the Cloudflare records we created, then the
 * row. The row survives an SES failure so the user can retry; Cloudflare
 * failures are reported as `leftoverDnsRecords` rather than blocking. With
 * AWS disconnected there is nothing to clean up on either side (the SES
 * identity belongs to an account we can no longer reach, and the Cloudflare
 * records are left for the same reason); the row is just deleted and every
 * record we created counts as left over.
 */
export async function deleteDomain(
  actor: TeamActor,
  id: string,
  deps: Pick<Deps, "fetch">,
): Promise<Result<DeleteOutcome>> {
  if (!can(actor.role, "domains.manage")) return DENIED;
  const d = await getDomain(actor.teamId, id);
  if (!d) return NOT_FOUND;
  const connected = (await getInstanceSettings()).awsMode !== "none";
  if (connected) {
    try {
      const ses = makeSes(await resolveAwsContext());
      await ses
        .send(new DeleteEmailIdentityCommand({ EmailIdentity: d.name }))
        .catch((e: unknown) => {
          if (errName(e) !== "NotFoundException") throw e;
        });
    } catch (e) {
      return { ok: false, error: `Could not remove: ${errMsg(e)}` };
    }
  }
  let leftoverDnsRecords = 0;
  if (!connected) {
    leftoverDnsRecords = d.expectedRecords.filter((r) => r.cloudflareId).length;
  } else if (d.dnsMode === "auto" && d.cloudflareZoneId) {
    const zoneId = d.cloudflareZoneId;
    const cf = await cloudflareClient(deps.fetch);
    for (const r of d.expectedRecords) {
      if (!r.cloudflareId) continue;
      if (!cf) {
        leftoverDnsRecords++;
        continue;
      }
      try {
        await cf.deleteRecord(zoneId, r.cloudflareId);
      } catch (e) {
        leftoverDnsRecords++;
        console.warn(
          `[domains] could not delete Cloudflare record ${r.type} ${r.name} (${r.cloudflareId}):`,
          errMsg(e),
        );
      }
    }
  }
  await db().delete(domains).where(eq(domains.id, id));
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "domains.delete",
    targetType: "domain",
    targetId: id,
    diff: { name: { from: d.name } },
    ...actor.meta,
  });
  return { ok: true, data: { leftoverDnsRecords } };
}

/** REST shape: DNS records without the Cloudflare ids, no internals. */
export const publicDomain = (d: Domain) => ({
  id: d.id,
  name: d.name,
  status: d.status,
  dnsMode: d.dnsMode,
  region: d.region,
  records: d.expectedRecords.map((r) => ({
    kind: r.kind,
    type: r.type,
    name: r.name,
    value: r.value,
    priority: r.priority ?? null,
    ok: r.ok,
  })),
  lastError: d.lastError,
  createdAt: d.createdAt,
  verifiedAt: d.verifiedAt,
});
