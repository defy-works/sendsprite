import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SESv2Client,
  CreateEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  GetEmailIdentityCommand,
  DeleteEmailIdentityCommand,
} from "@aws-sdk/client-sesv2";
import { and, eq } from "drizzle-orm";
import type { FetchLike } from "@/lib/cloudflare/client";
import type { Resolver } from "@/lib/dns/check";
import { auditLog, domains } from "@/db/schema";
import { startPg } from "./_pg";
import {
  connectTeamAws,
  connectTeamCloudflare,
  disconnectTeamAwsForTests,
  forgetTeamCloudflare,
} from "./helpers";

const ses = mockClient(SESv2Client);
let pg: Awaited<ReturnType<typeof startPg>>;
const cfCalls: { url: string; method?: string }[] = [];
const ok = (result: unknown) =>
  new Response(JSON.stringify({ success: true, result }));
/** Empty zone: every upsert creates (POST), every delete succeeds. */
const cfFetch: FetchLike = async (url, init) => {
  cfCalls.push({ url: String(url), method: init?.method });
  if (url.includes("/user/tokens/verify")) return ok({ status: "active" });
  if (/\/zones\?/.test(url)) return ok([{ id: "z1", name: "acme.com" }]);
  if (url.includes("/dns_records?")) return ok([]);
  if (url.includes("/dns_records")) return ok({ id: `r${cfCalls.length}` });
  return new Response("{}", { status: 404 });
};
/** Zone that already holds every record: upserts PATCH the existing ids. */
const cfExisting: FetchLike = async (url, init) => {
  cfCalls.push({ url: String(url), method: init?.method });
  const u = new URL(url);
  if (u.pathname.endsWith("/dns_records") && init?.method === undefined) {
    const type = u.searchParams.get("type")!;
    const name = u.searchParams.get("name")!;
    const content =
      type !== "TXT"
        ? "old"
        : name.startsWith("_dmarc")
          ? "v=DMARC1; p=reject"
          : "v=spf1 -all";
    return ok([{ id: `e-${type}-${name}`, type, name, content }]);
  }
  if (init?.method === "PATCH") return ok({ id: u.pathname.split("/").pop() });
  return cfFetch(url, init);
};
/** Cloudflare refuses every DELETE. */
const cfNoDelete: FetchLike = async (url, init) =>
  init?.method === "DELETE"
    ? new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        }),
        { status: 403 },
      )
    : cfFetch(url, init);
const awsErr = (name: string, message: string) =>
  Object.assign(new Error(message), { name });

beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
});
afterAll(async () => {
  await pg.stop();
});
/** Every test starts with AWS (keys) and Cloudflare connected. */
beforeEach(async () => {
  await connectTeamAws("org_1", {
    region: "eu-west-1",
    configSet: "sendsprite",
  });
  // Seed a live OAuth grant directly: the consent round trip is covered in
  // cloudflare-connect.test.ts, and going through it here would mean faking
  // Cloudflare's token endpoint in every domains test.
  await connectTeamCloudflare("org_1");
  cfCalls.length = 0;
});
afterEach(() => {
  ses.reset();
  cfCalls.length = 0;
});

const actor = {
  userId: "u1",
  teamId: "org_1",
  teamName: "Acme",
  role: "owner" as const,
};
const noop = { enqueue: async () => "", fetch: cfFetch };
const emptyDns: Resolver = {
  resolveNs: async () => [],
  resolveCname: async () => [],
  resolveMx: async () => [],
  resolveTxt: async () => [],
};
const pendingIdentity = {
  DkimAttributes: { Status: "PENDING" as const, Tokens: ["t1", "t2", "t3"] },
  MailFromAttributes: {
    MailFromDomain: "bounce.x",
    MailFromDomainStatus: "PENDING" as const,
    BehaviorOnMxFailure: "USE_DEFAULT_VALUE" as const,
  },
};

/** SES gave up on the records: the only statuses that demote a verified domain. */
const failedIdentity = {
  DkimAttributes: { Status: "FAILED" as const, Tokens: ["t1", "t2", "t3"] },
  MailFromAttributes: {
    MailFromDomain: "bounce.x",
    MailFromDomainStatus: "FAILED" as const,
    BehaviorOnMxFailure: "USE_DEFAULT_VALUE" as const,
  },
};
const temporaryIdentity = {
  DkimAttributes: {
    Status: "TEMPORARY_FAILURE" as const,
    Tokens: ["t1", "t2", "t3"],
  },
  MailFromAttributes: {
    MailFromDomain: "bounce.x",
    MailFromDomainStatus: "PENDING" as const,
    BehaviorOnMxFailure: "USE_DEFAULT_VALUE" as const,
  },
};

async function byName(name: string) {
  const [d] = await pg.db.select().from(domains).where(eq(domains.name, name));
  if (!d) throw new Error(`domain ${name} missing`);
  return d;
}
async function disconnectCloudflare() {
  await forgetTeamCloudflare("org_1");
}
function happyProvision() {
  ses.on(CreateEmailIdentityCommand).resolves({
    DkimAttributes: { Tokens: ["t1", "t2", "t3"], Status: "PENDING" },
  });
  ses.on(PutEmailIdentityMailFromAttributesCommand).resolves({});
}

/** One domain's life: create → provision → verify → delete, in order. */
describe("domains", () => {
  it("createDomain picks auto mode when a zone matches and enqueues provisioning", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createDomain } = await import("@/services/domains");
    const res = await createDomain(
      actor,
      { name: "Mail.Acme.com" },
      { enqueue, fetch: cfFetch },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      name: "mail.acme.com",
      dnsMode: "auto",
      cloudflareZoneId: "z1",
      status: "pending",
      mailFromDomain: "bounce.mail.acme.com",
      region: "eu-west-1",
    });
    expect(res.data.verifyUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(enqueue).toHaveBeenCalledWith("domain.provision", {
      domainId: res.data.id,
    });
  });
  it("createDomain strips a trailing dot before validating", async () => {
    const { createDomain } = await import("@/services/domains");
    const res = await createDomain(actor, { name: "dot.acme.com." }, noop);
    expect(res).toMatchObject({
      ok: true,
      data: { name: "dot.acme.com", dnsMode: "auto" },
    });
    // Later tests count rows; drop this one.
    await pg.db.delete(domains).where(eq(domains.name, "dot.acme.com"));
  });
  it("manual mode when no zone matches: provisioning touches SES only", async () => {
    const { createDomain, provisionDomain, deleteDomain } =
      await import("@/services/domains");
    const res = await createDomain(actor, { name: "mail.other.io" }, noop);
    expect(res).toMatchObject({
      ok: true,
      data: { dnsMode: "manual", cloudflareZoneId: null },
    });
    if (!res.ok) return;
    happyProvision();
    cfCalls.length = 0;
    const enqueue = vi.fn(async () => "job");
    await provisionDomain(res.data.id, { enqueue, fetch: cfFetch });
    const after = await byName("mail.other.io");
    expect(after.expectedRecords).toHaveLength(6);
    expect(after.expectedRecords.some((r) => r.cloudflareId)).toBe(false);
    expect(cfCalls).toHaveLength(0);
    expect(enqueue).toHaveBeenCalledWith(
      "domain.verify",
      { domainId: res.data.id },
      { startAfter: 30, singletonKey: res.data.id },
    );
    ses.on(DeleteEmailIdentityCommand).resolves({});
    cfCalls.length = 0;
    expect(await deleteDomain(actor, res.data.id, noop)).toEqual({
      ok: true,
      data: { leftoverDnsRecords: 0 },
    });
    expect(cfCalls).toHaveLength(0);
  });
  it("rejects duplicates and invalid names; member cannot create; needs AWS", async () => {
    const { createDomain } = await import("@/services/domains");
    expect(
      (await createDomain(actor, { name: "mail.acme.com" }, noop)).ok,
    ).toBe(false);
    expect(
      (await createDomain(actor, { name: "MAIL.acme.com " }, noop)).ok,
    ).toBe(false);
    expect((await createDomain(actor, { name: "not a domain" }, noop)).ok).toBe(
      false,
    );
    expect(
      (
        await createDomain(
          { ...actor, role: "member" },
          { name: "x.acme.com" },
          noop,
        )
      ).ok,
    ).toBe(false);
    await disconnectTeamAwsForTests("org_1");
    const res = await createDomain(actor, { name: "y.acme.com" }, noop);
    expect(res).toMatchObject({ ok: false, error: /Connect AWS/ });
    expect(await pg.db.select().from(domains)).toHaveLength(1);
  });
  it("createDomain keeps the row when the queue is down; retryProvisioning re-sends", async () => {
    const { createDomain, retryProvisioning } =
      await import("@/services/domains");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let res;
    try {
      res = await createDomain(
        actor,
        { name: "queued.acme.com" },
        {
          enqueue: async () => {
            throw new Error("pg-boss is not started");
          },
          fetch: cfFetch,
        },
      );
    } finally {
      err.mockRestore();
    }
    expect(res).toMatchObject({
      ok: true,
      data: {
        status: "pending",
        dkimTokens: [],
        lastError: "Could not queue provisioning: pg-boss is not started",
      },
    });
    if (!res.ok) return;
    const id = res.data.id;
    // Never provisioned, so the sweep must not pick it up.
    const { selectSweepCandidates } = await import("@/services/domains");
    expect((await selectSweepCandidates()).map((c) => c.id)).not.toContain(id);
    const enqueue = vi.fn(async () => "job");
    expect(
      (await retryProvisioning({ ...actor, role: "member" }, id, { enqueue }))
        .ok,
    ).toBe(false);
    expect(await retryProvisioning(actor, id, { enqueue })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(enqueue).toHaveBeenCalledWith("domain.provision", { domainId: id });
    expect(await byName("queued.acme.com")).toMatchObject({
      status: "pending",
      lastError: null,
    });
    expect(
      await pg.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "domains.retry_provisioning")),
    ).toHaveLength(1);
    // The queue failing again is reported and recorded.
    expect(
      await retryProvisioning(actor, id, {
        enqueue: async () => {
          throw new Error("still down");
        },
      }),
    ).toEqual({
      ok: false,
      code: "internal_error",
      error: "Could not queue provisioning: still down",
    });
    expect((await byName("queued.acme.com")).lastError).toMatch(/still down/);
    // Once provisioned, Re-verify is the tool, not a second provision.
    await pg.db
      .update(domains)
      .set({ dkimTokens: ["t1"] })
      .where(eq(domains.id, id));
    expect((await retryProvisioning(actor, id, { enqueue })).ok).toBe(false);
    await pg.db.delete(domains).where(eq(domains.id, id));
  });
  it("provisionDomain creates the identity and MAIL FROM, stores the records, and writes nothing to Cloudflare", async () => {
    happyProvision();
    const { provisionDomain } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    const enqueue = vi.fn(async () => "job");
    await provisionDomain(d.id, { enqueue, fetch: cfFetch });
    const after = await byName("mail.acme.com");
    expect(after.dkimTokens).toEqual(["t1", "t2", "t3"]);
    expect(after.dkimStatus).toBe("PENDING");
    expect(after.lastError).toBeNull();
    expect(after.expectedRecords).toHaveLength(6);
    // Stored, not applied: a zone is only written when someone clicks.
    expect(after.expectedRecords.some((r) => r.cloudflareId)).toBe(false);
    expect(after.dnsAppliedAt).toBeNull();
    expect(after.dnsMode).toBe("auto");
    expect(cfCalls.filter((c) => c.url.includes("/dns_records"))).toHaveLength(
      0,
    );
    expect(
      ses.commandCalls(CreateEmailIdentityCommand)[0]!.args[0].input,
    ).toEqual({
      EmailIdentity: "mail.acme.com",
      ConfigurationSetName: "sendsprite",
      DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
    });
    expect(
      ses.commandCalls(PutEmailIdentityMailFromAttributesCommand)[0]!.args[0]
        .input,
    ).toEqual({
      EmailIdentity: "mail.acme.com",
      MailFromDomain: "bounce.mail.acme.com",
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    });
    expect(enqueue).toHaveBeenCalledWith(
      "domain.verify",
      { domainId: d.id },
      { startAfter: 30, singletonKey: d.id },
    );
  });
  it("applyDnsRecords writes the records to Cloudflare, stamps dnsAppliedAt, audits and queues a verify", async () => {
    const { applyDnsRecords } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    const enqueue = vi.fn(async () => "job");
    expect(
      (await applyDnsRecords({ ...actor, role: "member" }, d.id, { enqueue }))
        .ok,
    ).toBe(false);
    const res = await applyDnsRecords(actor, d.id, { enqueue, fetch: cfFetch });
    expect(res.ok).toBe(true);
    const after = await byName("mail.acme.com");
    expect(after.expectedRecords.every((r) => r.cloudflareId)).toBe(true);
    expect(after.dnsAppliedAt).not.toBeNull();
    expect(after.lastError).toBeNull();
    expect(cfCalls.filter((c) => c.method === "POST")).toHaveLength(6);
    expect(enqueue).toHaveBeenCalledWith(
      "domain.verify",
      { domainId: d.id },
      { startAfter: 30, singletonKey: d.id },
    );
    expect(
      await pg.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "domains.apply_dns")),
    ).toHaveLength(1);
  });
  it("a Cloudflare failure mid-loop leaves the ids already created on the row", async () => {
    happyProvision();
    ses.on(DeleteEmailIdentityCommand).resolves({});
    const { createDomain, provisionDomain, applyDnsRecords, deleteDomain } =
      await import("@/services/domains");
    const res = await createDomain(actor, { name: "partial.acme.com" }, noop);
    if (!res.ok) throw new Error(res.error);
    let posts = 0;
    const cfThirdFails: FetchLike = async (url, init) => {
      if (init?.method === "POST" && ++posts === 3)
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "Cloudflare hiccup" }],
          }),
          { status: 500 },
        );
      return cfFetch(url, init);
    };
    await provisionDomain(res.data.id, {
      enqueue: noop.enqueue,
      fetch: cfFetch,
    });
    const failed = await applyDnsRecords(actor, res.data.id, {
      enqueue: noop.enqueue,
      fetch: cfThirdFails,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toMatch(/hiccup/);
    const after = await byName("partial.acme.com");
    expect(after.dkimTokens).toEqual(["t1", "t2", "t3"]);
    expect(after.lastError).toMatch(/hiccup/);
    expect(after.dnsAppliedAt).toBeNull();
    expect(after.expectedRecords).toHaveLength(6);
    expect(
      after.expectedRecords.filter((r) => r.cloudflareId).map((r) => r.kind),
    ).toEqual(["DKIM", "DKIM"]);
    // Re-apply (upsert by type+name) fills in the rest and clears the error.
    expect(
      (
        await applyDnsRecords(actor, res.data.id, {
          enqueue: noop.enqueue,
          fetch: cfFetch,
        })
      ).ok,
    ).toBe(true);
    const retried = await byName("partial.acme.com");
    expect(retried.expectedRecords.every((r) => r.cloudflareId)).toBe(true);
    expect(retried.lastError).toBeNull();
    expect(retried.dnsAppliedAt).not.toBeNull();
    expect((await deleteDomain(actor, res.data.id, noop)).ok).toBe(true);
  });
  it("re-applying patches the records Cloudflare already has and keeps their ids", async () => {
    const { applyDnsRecords } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    const enqueue = async () => "";
    expect(
      (await applyDnsRecords(actor, d.id, { enqueue, fetch: cfExisting })).ok,
    ).toBe(true);
    const after = await byName("mail.acme.com");
    expect(cfCalls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(cfCalls.filter((c) => c.method === "PATCH")).toHaveLength(6);
    expect(after.expectedRecords.map((r) => r.cloudflareId)).toEqual(
      after.expectedRecords.map((r) => `e-${r.type}-${r.name}`),
    );
    // Restore the ids the delete test expects to remove.
    await applyDnsRecords(actor, d.id, { enqueue, fetch: cfFetch });
  });
  it("provisionDomain converges when the identity already exists", async () => {
    ses
      .on(CreateEmailIdentityCommand)
      .rejects(awsErr("AlreadyExistsException", "exists"));
    ses.on(GetEmailIdentityCommand).resolves(pendingIdentity);
    ses.on(PutEmailIdentityMailFromAttributesCommand).resolves({});
    const { provisionDomain } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    expect(d.expectedRecords.every((r) => r.cloudflareId)).toBe(true);
    await provisionDomain(d.id, { enqueue: async () => "", fetch: cfFetch });
    const after = await byName("mail.acme.com");
    expect(after.dkimTokens).toEqual(["t1", "t2", "t3"]);
    // Recomputing the rows must not forget which are already in the zone.
    expect(after.expectedRecords.map((r) => r.cloudflareId)).toEqual(
      d.expectedRecords.map((r) => r.cloudflareId),
    );
    expect(after.dnsAppliedAt).toEqual(d.dnsAppliedAt);
    expect(cfCalls.filter((c) => c.url.includes("/dns_records"))).toHaveLength(
      0,
    );
  });
  it("provisionDomain records the error and rethrows so pg-boss retries", async () => {
    ses
      .on(CreateEmailIdentityCommand)
      .rejects(awsErr("TooManyRequestsException", "Rate exceeded"));
    const { provisionDomain } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    const enqueue = vi.fn(async () => "job");
    await expect(
      provisionDomain(d.id, { enqueue, fetch: cfFetch }),
    ).rejects.toThrow(/Rate exceeded/);
    expect((await byName("mail.acme.com")).lastError).toMatch(/Rate exceeded/);
    expect(enqueue).not.toHaveBeenCalled();
    expect((await byName("mail.acme.com")).status).toBe("pending");
    // The handler's final attempt is terminal: the domain is marked failed.
    await expect(
      provisionDomain(
        d.id,
        { enqueue, fetch: cfFetch },
        { finalAttempt: true },
      ),
    ).rejects.toThrow(/Rate exceeded/);
    expect(await byName("mail.acme.com")).toMatchObject({
      status: "failed",
      lastError: /Rate exceeded/,
    });
    await pg.db
      .update(domains)
      .set({ status: "pending" })
      .where(eq(domains.id, d.id));
  });
  it("Cloudflare disconnected: provisioning is unaffected and Apply refuses without demoting the mode", async () => {
    const { createDomain, provisionDomain, applyDnsRecords, deleteDomain } =
      await import("@/services/domains");
    const res = await createDomain(actor, { name: "deg.acme.com" }, noop);
    if (!res.ok) throw new Error(res.error);
    expect(res.data.dnsMode).toBe("auto");
    await disconnectCloudflare();
    happyProvision();
    const enqueue = vi.fn(async () => "job");
    await provisionDomain(res.data.id, { enqueue, fetch: cfFetch });
    const after = await byName("deg.acme.com");
    // Still a Cloudflare domain: reconnecting makes Apply work again
    // without re-adding it.
    expect(after).toMatchObject({ dnsMode: "auto", lastError: null });
    expect(after.expectedRecords).toHaveLength(6);
    expect(after.expectedRecords.some((r) => r.cloudflareId)).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(
      await applyDnsRecords(actor, res.data.id, { enqueue, fetch: cfFetch }),
    ).toMatchObject({
      ok: false,
      code: "not_configured",
      error: /Cloudflare is not connected/,
    });
    expect((await byName("deg.acme.com")).dnsMode).toBe("auto");
    ses.on(DeleteEmailIdentityCommand).resolves({});
    expect((await deleteDomain(actor, res.data.id, noop)).ok).toBe(true);
  });
  it("Apply refuses a manual-mode domain and one SES has not provisioned yet", async () => {
    const { createDomain, provisionDomain, applyDnsRecords, deleteDomain } =
      await import("@/services/domains");
    const manual = await createDomain(
      actor,
      { name: "nozone.example.org" },
      noop,
    );
    if (!manual.ok) throw new Error(manual.error);
    expect(manual.data.dnsMode).toBe("manual");
    // Not provisioned yet: nothing to apply.
    expect(await applyDnsRecords(actor, manual.data.id, noop)).toMatchObject({
      ok: false,
      code: "conflict",
      error: /not issued/,
    });
    happyProvision();
    await provisionDomain(manual.data.id, noop);
    expect(await applyDnsRecords(actor, manual.data.id, noop)).toMatchObject({
      ok: false,
      code: "conflict",
      error: /DNS provider/,
    });
    expect(cfCalls.filter((c) => c.url.includes("/dns_records"))).toHaveLength(
      0,
    );
    ses.on(DeleteEmailIdentityCommand).resolves({});
    expect((await deleteDomain(actor, manual.data.id, noop)).ok).toBe(true);
  });
  it("verifyDomain flips to verified when SES + DNS agree", async () => {
    ses.on(GetEmailIdentityCommand).resolves({
      DkimAttributes: { Status: "SUCCESS", Tokens: ["t1", "t2", "t3"] },
      MailFromAttributes: {
        MailFromDomainStatus: "SUCCESS",
        MailFromDomain: "bounce.mail.acme.com",
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
      },
      VerifiedForSendingStatus: true,
    });
    const resolver: Resolver = {
      resolveNs: async () => [],
      resolveCname: async () => ["t1.dkim.amazonses.com"],
      resolveMx: async () => [
        { exchange: "feedback-smtp.eu-west-1.amazonses.com", priority: 10 },
      ],
      resolveTxt: async (n) =>
        n.startsWith("_dmarc")
          ? [["v=DMARC1; p=none"]]
          : [["v=spf1 include:amazonses.com ~all"]],
    };
    const { verifyDomain } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    await verifyDomain(d.id, { resolver, enqueue: noop.enqueue });
    const after = await byName("mail.acme.com");
    expect(after).toMatchObject({
      status: "verified",
      dkimStatus: "SUCCESS",
      mailFromStatus: "SUCCESS",
      spfOk: true,
      dmarcOk: true,
      lastError: null,
    });
    expect(after.verifiedAt).toBeInstanceOf(Date);
    expect(after.lastCheckedAt).toBeInstanceOf(Date);
    // Already verified: a stray re-run is a no-op.
    ses.reset();
    await verifyDomain(d.id, { resolver, enqueue: noop.enqueue });
    expect(ses.commandCalls(GetEmailIdentityCommand)).toHaveLength(0);
  });
  it("reverifyDomain keeps a verified domain verified, demotes only when SES reports FAILED", async () => {
    const { reverifyDomain, verifyDomain } = await import("@/services/domains");
    const verifyDomainForced = (id: string) =>
      verifyDomain(
        id,
        { resolver: emptyDns, enqueue: noop.enqueue },
        { force: true },
      );
    const before = await byName("mail.acme.com");
    expect(before.status).toBe("verified");
    const success = {
      DkimAttributes: {
        Status: "SUCCESS" as const,
        Tokens: ["t1", "t2", "t3"],
      },
      MailFromAttributes: {
        MailFromDomainStatus: "SUCCESS" as const,
        MailFromDomain: "bounce.mail.acme.com",
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE" as const,
      },
    };
    ses.on(GetEmailIdentityCommand).resolves(success);
    expect(
      (
        await reverifyDomain(actor, before.id, {
          resolver: emptyDns,
          enqueue: noop.enqueue,
        })
      ).ok,
    ).toBe(true);
    const still = await byName("mail.acme.com");
    expect(still.status).toBe("verified");
    expect(still.verifiedAt!.getTime()).toBe(before.verifiedAt!.getTime());
    expect(still.lastCheckedAt!.getTime()).toBeGreaterThan(
      before.lastCheckedAt!.getTime(),
    );
    // A transient SES status (even with the 72 h window long past) keeps
    // the domain verified; the check notes it and the sweep will look again.
    await pg.db
      .update(domains)
      .set({ verifyUntil: new Date(Date.now() - 1000) })
      .where(eq(domains.id, before.id));
    ses.reset();
    ses.on(GetEmailIdentityCommand).resolves(temporaryIdentity);
    await verifyDomainForced(before.id);
    const kept = await byName("mail.acme.com");
    expect(kept).toMatchObject({
      status: "verified",
      dkimStatus: "TEMPORARY_FAILURE",
      mailFromStatus: "PENDING",
      lastError: "SES reported TEMPORARY_FAILURE/PENDING; will re-check",
    });
    expect(kept.verifiedAt!.getTime()).toBe(before.verifiedAt!.getTime());
    expect(kept.lastCheckedAt!.getTime()).toBeGreaterThan(
      still.lastCheckedAt!.getTime(),
    );
    // SES gave up (FAILED): demoted to pending, verifiedAt cleared.
    ses.reset();
    ses.on(GetEmailIdentityCommand).resolves(failedIdentity);
    expect(
      (
        await reverifyDomain(actor, before.id, {
          resolver: emptyDns,
          enqueue: noop.enqueue,
        })
      ).ok,
    ).toBe(true);
    const demoted = await byName("mail.acme.com");
    expect(demoted.status).toBe("pending");
    expect(demoted.verifiedAt).toBeNull();
    expect(demoted.lastError).toBeNull();
    // Later tests expect the fixture verified again.
    ses.reset();
    ses.on(GetEmailIdentityCommand).resolves(success);
    expect(
      (
        await reverifyDomain(actor, before.id, {
          resolver: emptyDns,
          enqueue: noop.enqueue,
        })
      ).ok,
    ).toBe(true);
    expect((await byName("mail.acme.com")).status).toBe("verified");
  });
  it("sweep re-checks a verified domain after 24 h with force; demotion and re-verification fan out webhooks", async () => {
    const { selectSweepCandidates, verifyDomain } =
      await import("@/services/domains");
    const { createWebhook } = await import("@/services/webhooks");
    const { webhookDeliveries } = await import("@/db/schema");
    const hook = await createWebhook(actor, {
      url: "https://hooks.acme.com/domains",
      events: ["domain.verified", "domain.failed"],
    });
    if (!hook.ok) throw new Error(hook.error);
    const d = await byName("mail.acme.com");
    expect(d.status).toBe("verified");
    // Checked minutes ago: not due. A day old: due, and flagged `force`.
    expect(await selectSweepCandidates()).toEqual([]);
    await pg.db
      .update(domains)
      .set({ lastCheckedAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(domains.id, d.id));
    expect(await selectSweepCandidates()).toEqual([{ id: d.id, force: true }]);
    // Without force the verified row is untouched (a stray plain job).
    await verifyDomain(d.id, noop);
    expect(ses.commandCalls(GetEmailIdentityCommand)).toHaveLength(0);
    // Forced: SES reports FAILED → demoted, `domain.failed` fanned out. The
    // original 72 h window is long gone; demotion opens a fresh one.
    await pg.db
      .update(domains)
      .set({ verifyUntil: new Date(Date.now() - 1000) })
      .where(eq(domains.id, d.id));
    const enqueue = vi.fn(async () => "job");
    ses.on(GetEmailIdentityCommand).resolves(failedIdentity);
    await verifyDomain(d.id, { resolver: emptyDns, enqueue }, { force: true });
    const demotedRow = await byName("mail.acme.com");
    expect(demotedRow.status).toBe("pending");
    expect(demotedRow.verifyUntil!.getTime()).toBeGreaterThan(
      Date.now() + 71 * 3600_000,
    );
    expect(await selectSweepCandidates()).toEqual([]);
    // The following sweep tick (still FAILED) keeps it pending, not failed.
    await pg.db
      .update(domains)
      .set({ lastCheckedAt: new Date(Date.now() - 200_000) })
      .where(eq(domains.id, d.id));
    expect(await selectSweepCandidates()).toEqual([{ id: d.id, force: false }]);
    await verifyDomain(d.id, { resolver: emptyDns, enqueue });
    expect((await byName("mail.acme.com")).status).toBe("pending");
    const deliveries = () =>
      pg.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, hook.data.id))
        .orderBy(webhookDeliveries.createdAt);
    let rows = await deliveries();
    expect(rows.map((r) => r.eventType)).toEqual(["domain.failed"]);
    expect(rows[0]!.payload).toMatchObject({
      type: "domain.failed",
      data: { domain: { id: d.id, name: "mail.acme.com", status: "pending" } },
    });
    expect(enqueue).toHaveBeenCalledWith(
      "webhook.deliver",
      { deliveryId: rows[0]!.id },
      expect.objectContaining({ singletonKey: rows[0]!.id }),
    );
    // Back to SUCCESS: verified again, `domain.verified` fanned out.
    ses.reset();
    ses.on(GetEmailIdentityCommand).resolves({
      DkimAttributes: { Status: "SUCCESS", Tokens: ["t1", "t2", "t3"] },
      MailFromAttributes: {
        MailFromDomainStatus: "SUCCESS",
        MailFromDomain: "bounce.mail.acme.com",
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
      },
    });
    await verifyDomain(d.id, { resolver: emptyDns, enqueue });
    expect((await byName("mail.acme.com")).status).toBe("verified");
    rows = await deliveries();
    expect(rows.map((r) => r.eventType)).toEqual([
      "domain.failed",
      "domain.verified",
    ]);
    expect(rows[1]!.payload).toMatchObject({
      data: { domain: { id: d.id, status: "verified" } },
    });
    // A check that leaves the status alone fans out nothing.
    await verifyDomain(d.id, { resolver: emptyDns, enqueue }, { force: true });
    expect(await deliveries()).toHaveLength(2);
    await pg.db.delete(webhookDeliveries);
  });
  it("verifyDomain leaves a pending domain to the sweep and fails it after verifyUntil", async () => {
    ses.on(GetEmailIdentityCommand).resolves(pendingIdentity);
    const { verifyDomain, createDomain, selectSweepCandidates } =
      await import("@/services/domains");
    const created = await createDomain(actor, { name: "slow.acme.com" }, noop);
    if (!created.ok) throw new Error(created.error);
    const id = created.data.id;
    // Not provisioned yet (no tokens): the sweep ignores it.
    expect(await selectSweepCandidates()).toEqual([]);
    await pg.db
      .update(domains)
      .set({ dkimTokens: ["t1", "t2", "t3"] })
      .where(eq(domains.id, id));
    // Never checked: due. (mail.acme.com is verified and freshly checked,
    // so it stays out.)
    const due = [{ id, force: false }];
    expect(await selectSweepCandidates()).toEqual(due);
    await verifyDomain(id, { resolver: emptyDns, enqueue: noop.enqueue });
    await verifyDomain(id, { resolver: emptyDns, enqueue: noop.enqueue });
    expect((await byName("slow.acme.com")).status).toBe("pending");
    // Just checked: not due until the check is ~100 s old.
    expect(await selectSweepCandidates()).toEqual([]);
    await pg.db
      .update(domains)
      .set({ lastCheckedAt: new Date(Date.now() - 101_000) })
      .where(eq(domains.id, id));
    expect(await selectSweepCandidates()).toEqual(due);
    // Past the window it is still due, and the check fails it for good.
    await pg.db
      .update(domains)
      .set({ verifyUntil: new Date(Date.now() - 1000) })
      .where(eq(domains.id, id));
    expect(await selectSweepCandidates()).toEqual(due);
    await verifyDomain(id, { resolver: emptyDns, enqueue: noop.enqueue });
    const after = await byName("slow.acme.com");
    expect(after.status).toBe("failed");
    expect(after.lastError).toMatch(/timed out/);
    expect(await selectSweepCandidates()).toEqual([]);
  });
  it("reverifyDomain resets the window, audits, and checks inline", async () => {
    ses.on(GetEmailIdentityCommand).resolves(pendingIdentity);
    const { reverifyDomain } = await import("@/services/domains");
    // Re-verify needs a provisioned identity; the fixture skipped the job.
    await pg.db
      .update(domains)
      .set({ dkimTokens: ["t1", "t2", "t3"] })
      .where(eq(domains.name, "slow.acme.com"));
    const d = await byName("slow.acme.com");
    const deps = { resolver: emptyDns, enqueue: noop.enqueue };
    expect(
      (await reverifyDomain({ ...actor, role: "member" }, d.id, deps)).ok,
    ).toBe(false);
    expect(await reverifyDomain(actor, d.id, deps)).toEqual({
      ok: true,
      data: undefined,
    });
    expect(ses.commandCalls(GetEmailIdentityCommand)).toHaveLength(1);
    const after = await byName("slow.acme.com");
    expect(after.status).toBe("pending");
    expect(after.lastError).toBeNull();
    expect(after.verifyUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(after.lastCheckedAt!.getTime()).toBeGreaterThan(
      d.lastCheckedAt!.getTime(),
    );
    expect(
      await pg.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "domains.reverify"),
            eq(auditLog.targetId, d.id),
          ),
        ),
    ).toHaveLength(1);
    // A failing check is reported, not thrown.
    ses.reset();
    ses
      .on(GetEmailIdentityCommand)
      .rejects(awsErr("TooManyRequestsException", "Rate exceeded"));
    expect(await reverifyDomain(actor, d.id, deps)).toMatchObject({
      ok: false,
      error: /Rate exceeded/,
    });
  });
  it("reverifyDomain refuses a domain that has not been provisioned", async () => {
    const { createDomain, reverifyDomain } = await import("@/services/domains");
    const enqueue = vi.fn(async () => "job");
    const res = await createDomain(
      actor,
      { name: "unprovisioned.acme.com" },
      { enqueue, fetch: cfFetch },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    ses.reset();
    expect(await reverifyDomain(actor, res.data.id, noop)).toEqual({
      ok: false,
      code: "conflict",
      error: "Provisioning hasn't finished yet.",
    });
    expect(ses.commandCalls(GetEmailIdentityCommand)).toHaveLength(0);
    // Later assertions list the team's domains; leave only the fixture.
    await pg.db.delete(domains).where(eq(domains.id, res.data.id));
  });
  it("verifyDomain records the error without throwing when AWS is disconnected", async () => {
    await disconnectTeamAwsForTests("org_1");
    const { verifyDomain } = await import("@/services/domains");
    const d = await byName("slow.acme.com");
    await verifyDomain(d.id, { resolver: emptyDns, enqueue: noop.enqueue });
    const after = await byName("slow.acme.com");
    expect(after.status).toBe("pending");
    expect(after.lastError).toMatch(/AWS is not connected/);
    expect(after.lastCheckedAt!.getTime()).toBeGreaterThan(
      d.lastCheckedAt!.getTime(),
    );
    expect(ses.commandCalls(GetEmailIdentityCommand)).toHaveLength(0);
  });
  it("verifyDomain records other SES errors and rethrows for retry", async () => {
    ses
      .on(GetEmailIdentityCommand)
      .rejects(awsErr("TooManyRequestsException", "Rate exceeded"));
    const { verifyDomain } = await import("@/services/domains");
    const d = await byName("slow.acme.com");
    await expect(
      verifyDomain(d.id, { resolver: emptyDns, enqueue: noop.enqueue }),
    ).rejects.toThrow(/Rate exceeded/);
    const after = await byName("slow.acme.com");
    expect(after.status).toBe("pending");
    expect(after.lastError).toMatch(/Rate exceeded/);
  });
  it("verifyDomain fails the domain when the SES identity has vanished", async () => {
    ses
      .on(GetEmailIdentityCommand)
      .rejects(awsErr("NotFoundException", "identity not found"));
    const { verifyDomain } = await import("@/services/domains");
    const d = await byName("slow.acme.com");
    await verifyDomain(d.id, { resolver: emptyDns, enqueue: noop.enqueue });
    const after = await byName("slow.acme.com");
    expect(after.status).toBe("failed");
    expect(after.lastError).toMatch(/identity was removed/);
  });
  it("deleteDomain removes the identity and the Cloudflare records it created", async () => {
    ses.on(DeleteEmailIdentityCommand).resolves({});
    const { deleteDomain, listDomains } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    expect(
      (await deleteDomain({ ...actor, role: "member" }, d.id, noop)).ok,
    ).toBe(false);
    expect(
      (await deleteDomain({ ...actor, teamId: "org_other" }, d.id, noop)).ok,
    ).toBe(false);
    expect(await deleteDomain(actor, d.id, { fetch: cfFetch })).toEqual({
      ok: true,
      data: { leftoverDnsRecords: 0 },
    });
    expect(cfCalls.filter((c) => c.method === "DELETE")).toHaveLength(6);
    expect(
      ses.commandCalls(DeleteEmailIdentityCommand)[0]!.args[0].input,
    ).toEqual({ EmailIdentity: "mail.acme.com" });
    expect(
      await pg.db.select().from(domains).where(eq(domains.id, d.id)),
    ).toHaveLength(0);
    expect((await listDomains("org_1")).map((x) => x.name)).toEqual([
      "slow.acme.com",
    ]);
  });
  it("deleteDomain reports Cloudflare records it could not remove", async () => {
    happyProvision();
    ses.on(DeleteEmailIdentityCommand).resolves({});
    const { createDomain, provisionDomain, applyDnsRecords, deleteDomain } =
      await import("@/services/domains");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Cloudflare refuses the deletes.
      const a = await createDomain(actor, { name: "left.acme.com" }, noop);
      if (!a.ok) throw new Error(a.error);
      await provisionDomain(a.data.id, {
        enqueue: async () => "",
        fetch: cfFetch,
      });
      await applyDnsRecords(actor, a.data.id, {
        enqueue: async () => "",
        fetch: cfFetch,
      });
      expect(
        await deleteDomain(actor, a.data.id, { fetch: cfNoDelete }),
      ).toEqual({ ok: true, data: { leftoverDnsRecords: 6 } });
      expect(warn).toHaveBeenCalledTimes(6);
      expect(warn.mock.calls[0]![0]).toMatch(/could not delete Cloudflare/);
      // Cloudflare disconnected: nothing is attempted, everything is left.
      warn.mockClear();
      const b = await createDomain(actor, { name: "gone.acme.com" }, noop);
      if (!b.ok) throw new Error(b.error);
      await provisionDomain(b.data.id, {
        enqueue: async () => "",
        fetch: cfFetch,
      });
      await applyDnsRecords(actor, b.data.id, {
        enqueue: async () => "",
        fetch: cfFetch,
      });
      await disconnectCloudflare();
      cfCalls.length = 0;
      expect(await deleteDomain(actor, b.data.id, { fetch: cfFetch })).toEqual({
        ok: true,
        data: { leftoverDnsRecords: 6 },
      });
      expect(cfCalls).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect((await pg.db.select().from(domains)).map((d) => d.name)).toEqual([
      "slow.acme.com",
    ]);
  });
  it("deleteDomain with AWS disconnected removes the row and reports every record as left over", async () => {
    happyProvision();
    const { createDomain, provisionDomain, applyDnsRecords, deleteDomain } =
      await import("@/services/domains");
    const res = await createDomain(actor, { name: "off.acme.com" }, noop);
    if (!res.ok) throw new Error(res.error);
    await provisionDomain(res.data.id, {
      enqueue: noop.enqueue,
      fetch: cfFetch,
    });
    await applyDnsRecords(actor, res.data.id, {
      enqueue: noop.enqueue,
      fetch: cfFetch,
    });
    await disconnectTeamAwsForTests("org_1");
    ses.reset();
    cfCalls.length = 0;
    expect(await deleteDomain(actor, res.data.id, { fetch: cfFetch })).toEqual({
      ok: true,
      data: { leftoverDnsRecords: 6 },
    });
    expect(ses.calls()).toHaveLength(0);
    expect(cfCalls).toHaveLength(0);
    expect(
      await pg.db.select().from(domains).where(eq(domains.id, res.data.id)),
    ).toHaveLength(0);
    expect(
      await pg.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "domains.delete")),
    ).not.toHaveLength(0);
  });
  it("deleteDomain tolerates a missing identity and keeps the row when SES fails", async () => {
    const { deleteDomain } = await import("@/services/domains");
    const d = await byName("slow.acme.com");
    ses
      .on(DeleteEmailIdentityCommand)
      .rejects(awsErr("AccessDeniedException", "not authorized"));
    expect(await deleteDomain(actor, d.id, noop)).toMatchObject({
      ok: false,
      error: /not authorized/,
    });
    expect(await byName("slow.acme.com")).toBeTruthy();
    ses.reset();
    ses
      .on(DeleteEmailIdentityCommand)
      .rejects(awsErr("NotFoundException", "gone"));
    expect((await deleteDomain(actor, d.id, noop)).ok).toBe(true);
    expect(await pg.db.select().from(domains)).toHaveLength(0);
  });
});
