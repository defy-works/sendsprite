import { and, eq } from "drizzle-orm";
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

/** `startAfter` is a delay in seconds (pg-boss casts a number to an interval). */
export type Enqueue = (
  queue: string,
  data: object,
  opts?: { startAfter?: number },
) => Promise<unknown>;

/** Injection points: the job queue, Cloudflare's fetch, and the DNS resolver. */
interface Deps {
  enqueue: Enqueue;
  fetch?: FetchLike;
  resolver?: Resolver;
}

/** How often a pending domain is re-checked, and for how long before it fails. */
const VERIFY_EVERY_S = 120;
const FIRST_VERIFY_AFTER_S = 30;
const VERIFY_WINDOW_MS = 72 * 3600 * 1000;
const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DENIED: Result<never> = {
  ok: false,
  error: "You don't have permission to do that.",
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errName = (e: unknown) => (e as { name?: string }).name;

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
    .object({ name: z.string().transform((s) => s.trim().toLowerCase()) })
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
  if (dupe)
    return {
      ok: false,
      error: "That domain is already added on this instance.",
    };
  const zone = matchZone(name, await listZones(deps.fetch));
  const id = newId("dom");
  const [row] = await db()
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
  await deps.enqueue("domain.provision", { domainId: id });
  return { ok: true, data: row };
}

/**
 * Job: SES identity + MAIL FROM + (auto mode) Cloudflare records, then
 * schedule the first verification. Idempotent: an existing identity is
 * read back for its tokens and Cloudflare upserts by (type, name[, content]).
 * Throws after recording `lastError` so pg-boss retries.
 */
export async function provisionDomain(
  domainId: string,
  deps: Deps,
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
    let recs = expectedRecords({
      domain: d.name,
      region: d.region,
      dkimTokens: tokens,
      mailFromDomain: d.mailFromDomain,
    });
    if (d.dnsMode === "auto" && d.cloudflareZoneId) {
      const zoneId = d.cloudflareZoneId;
      const cf = await cloudflareClient(deps.fetch);
      if (!cf) throw new Error("Cloudflare is no longer connected");
      recs = await Promise.all(
        recs.map(async (r) => ({
          ...r,
          cloudflareId: (
            await cf.upsertRecord(zoneId, {
              type: r.type,
              name: r.name,
              content: r.value,
              priority: r.priority,
            })
          ).id,
        })),
      );
    }
    await db()
      .update(domains)
      .set({
        dkimTokens: tokens,
        dkimStatus: identity.DkimAttributes?.Status ?? null,
        expectedRecords: recs,
        lastError: null,
      })
      .where(eq(domains.id, d.id));
    await deps.enqueue(
      "domain.verify",
      { domainId: d.id },
      { startAfter: FIRST_VERIFY_AFTER_S },
    );
  } catch (e) {
    await db()
      .update(domains)
      .set({ lastError: errMsg(e) })
      .where(eq(domains.id, d.id));
    throw e;
  }
}

/**
 * Job: poll SES + DNS. Verified → stop; pending → re-enqueue; past the
 * window → failed. With AWS disconnected the loop stops (lastError set,
 * status untouched) rather than retrying forever; Re-verify restarts it.
 */
export async function verifyDomain(
  domainId: string,
  deps: Pick<Deps, "enqueue" | "resolver">,
): Promise<void> {
  const d = await loadById(domainId);
  if (!d || d.status === "verified") return;
  let ses;
  try {
    ses = makeSes(await resolveAwsContext());
  } catch (e) {
    await db()
      .update(domains)
      .set({ lastError: errMsg(e), lastCheckedAt: new Date() })
      .where(eq(domains.id, d.id));
    return;
  }
  const ident = await ses.send(
    new GetEmailIdentityCommand({ EmailIdentity: d.name }),
  );
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
      verifiedAt: verified ? new Date() : null,
      lastError: expired
        ? "Verification timed out after 72 hours. Check the records and click Re-verify."
        : null,
    })
    .where(eq(domains.id, d.id));
  if (!verified && !expired)
    await deps.enqueue(
      "domain.verify",
      { domainId: d.id },
      { startAfter: VERIFY_EVERY_S },
    );
}

/** Manual "Re-verify": resets the window and runs one check now. */
export async function reverifyDomain(
  actor: TeamActor,
  id: string,
  deps: Pick<Deps, "enqueue">,
): Promise<Result> {
  if (!can(actor.role, "domains.manage")) return DENIED;
  const d = await getDomain(actor.teamId, id);
  if (!d) return { ok: false, error: "Domain not found." };
  await db()
    .update(domains)
    .set({
      status: "pending",
      verifyUntil: new Date(Date.now() + VERIFY_WINDOW_MS),
      lastError: null,
    })
    .where(eq(domains.id, id));
  await deps.enqueue("domain.verify", { domainId: id });
  return { ok: true, data: undefined };
}

/**
 * Remove the SES identity and the Cloudflare records we created, then the
 * row. The row survives a cloud failure so the user can retry; a record
 * already deleted by hand is not an error.
 */
export async function deleteDomain(
  actor: TeamActor,
  id: string,
  deps: Pick<Deps, "fetch">,
): Promise<Result> {
  if (!can(actor.role, "domains.manage")) return DENIED;
  const d = await getDomain(actor.teamId, id);
  if (!d) return { ok: false, error: "Domain not found." };
  try {
    const ses = makeSes(await resolveAwsContext());
    await ses
      .send(new DeleteEmailIdentityCommand({ EmailIdentity: d.name }))
      .catch((e: unknown) => {
        if (errName(e) !== "NotFoundException") throw e;
      });
    if (d.dnsMode === "auto" && d.cloudflareZoneId) {
      const cf = await cloudflareClient(deps.fetch);
      if (cf)
        for (const r of d.expectedRecords)
          if (r.cloudflareId)
            await cf
              .deleteRecord(d.cloudflareZoneId, r.cloudflareId)
              .catch(() => undefined);
    }
  } catch (e) {
    return { ok: false, error: `Could not remove: ${errMsg(e)}` };
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
  return { ok: true, data: undefined };
}
