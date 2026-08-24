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
import { eq } from "drizzle-orm";
import type { FetchLike } from "@/lib/cloudflare/client";
import type { Resolver } from "@/lib/dns/check";
import { domains } from "@/db/schema";
import { startPg } from "./_pg";

const ses = mockClient(SESv2Client);
let pg: Awaited<ReturnType<typeof startPg>>;
const cfCalls: { url: string; method?: string }[] = [];
const cfFetch: FetchLike = async (url, init) => {
  cfCalls.push({ url: String(url), method: init?.method });
  if (url.includes("/user/tokens/verify"))
    return new Response(
      JSON.stringify({ success: true, result: { status: "active" } }),
    );
  if (/\/zones\?/.test(url))
    return new Response(
      JSON.stringify({
        success: true,
        result: [{ id: "z1", name: "acme.com" }],
      }),
    );
  if (url.includes("/dns_records?"))
    return new Response(JSON.stringify({ success: true, result: [] }));
  if (url.includes("/dns_records"))
    return new Response(
      JSON.stringify({ success: true, result: { id: `r${cfCalls.length}` } }),
    );
  return new Response("{}", { status: 404 });
};
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
  const { updateInstanceSettings } =
    await import("@/services/instance-settings");
  await updateInstanceSettings(
    {
      awsMode: "keys",
      awsRegion: "eu-west-1",
      awsAccessKey: "AKIAEXAMPLE",
      awsSecret: "s3cr3t",
      sesConfigSet: "sendsprite",
    },
    undefined,
    { audit: false },
  );
  const { connectCloudflare } = await import("@/services/cloudflare-connect");
  const cf = await connectCloudflare(
    "cf-token-value-0123456789",
    { userId: "u1" },
    cfFetch,
  );
  if (!cf.ok) throw new Error(cf.error);
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
  resolveCname: async () => [],
  resolveMx: async () => [],
  resolveTxt: async () => [],
};

async function byName(name: string) {
  const [d] = await pg.db.select().from(domains).where(eq(domains.name, name));
  if (!d) throw new Error(`domain ${name} missing`);
  return d;
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
  it("falls back to manual mode when no zone matches", async () => {
    const { createDomain, deleteDomain } = await import("@/services/domains");
    const res = await createDomain(actor, { name: "mail.other.io" }, noop);
    expect(res).toMatchObject({
      ok: true,
      data: { dnsMode: "manual", cloudflareZoneId: null },
    });
    if (!res.ok) return;
    ses.on(DeleteEmailIdentityCommand).resolves({});
    expect((await deleteDomain(actor, res.data.id, noop)).ok).toBe(true);
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
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    await updateInstanceSettings({ awsMode: "none" }, undefined, {
      audit: false,
    });
    const res = await createDomain(actor, { name: "y.acme.com" }, noop);
    expect(res).toMatchObject({ ok: false, error: /Connect AWS/ });
    expect(await pg.db.select().from(domains)).toHaveLength(1);
  });
  it("provisionDomain creates the identity, MAIL FROM, writes records to Cloudflare", async () => {
    ses.on(CreateEmailIdentityCommand).resolves({
      DkimAttributes: { Tokens: ["t1", "t2", "t3"], Status: "PENDING" },
    });
    ses.on(PutEmailIdentityMailFromAttributesCommand).resolves({});
    const { provisionDomain } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    const enqueue = vi.fn(async () => "job");
    await provisionDomain(d.id, { enqueue, fetch: cfFetch });
    const after = await byName("mail.acme.com");
    expect(after.dkimTokens).toEqual(["t1", "t2", "t3"]);
    expect(after.dkimStatus).toBe("PENDING");
    expect(after.expectedRecords).toHaveLength(6);
    expect(after.expectedRecords.every((r) => r.cloudflareId)).toBe(true);
    expect(cfCalls.filter((c) => c.method === "POST")).toHaveLength(6);
    expect(
      ses.commandCalls(CreateEmailIdentityCommand)[0]!.args[0].input,
    ).toMatchObject({
      EmailIdentity: "mail.acme.com",
      ConfigurationSetName: "sendsprite",
    });
    expect(
      ses.commandCalls(PutEmailIdentityMailFromAttributesCommand)[0]!.args[0]
        .input,
    ).toMatchObject({
      EmailIdentity: "mail.acme.com",
      MailFromDomain: "bounce.mail.acme.com",
    });
    expect(enqueue).toHaveBeenCalledWith(
      "domain.verify",
      { domainId: d.id },
      expect.objectContaining({ startAfter: expect.any(Number) }),
    );
  });
  it("provisionDomain converges when the identity already exists", async () => {
    ses
      .on(CreateEmailIdentityCommand)
      .rejects(awsErr("AlreadyExistsException", "exists"));
    ses.on(GetEmailIdentityCommand).resolves({
      DkimAttributes: { Tokens: ["t1", "t2", "t3"], Status: "PENDING" },
    });
    ses.on(PutEmailIdentityMailFromAttributesCommand).resolves({});
    const { provisionDomain } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    await provisionDomain(d.id, { enqueue: async () => "", fetch: cfFetch });
    expect((await byName("mail.acme.com")).dkimTokens).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
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
  });
  it("verifyDomain flips to verified when SES + DNS agree, else re-enqueues", async () => {
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
      resolveCname: async () => ["t1.dkim.amazonses.com"],
      resolveMx: async () => [
        { exchange: "feedback-smtp.eu-west-1.amazonses.com", priority: 10 },
      ],
      resolveTxt: async (n) =>
        n.startsWith("_dmarc")
          ? [["v=DMARC1; p=none; rua=mailto:dmarc@mail.acme.com"]]
          : [["v=spf1 include:amazonses.com ~all"]],
    };
    const { verifyDomain } = await import("@/services/domains");
    const d = await byName("mail.acme.com");
    const enqueue = vi.fn(async () => "job");
    await verifyDomain(d.id, { enqueue, resolver });
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
    expect(enqueue).not.toHaveBeenCalled();
    // Already verified: a stray re-run is a no-op.
    ses.reset();
    await verifyDomain(d.id, { enqueue, resolver });
    expect(ses.commandCalls(GetEmailIdentityCommand)).toHaveLength(0);
  });
  it("verifyDomain re-enqueues while pending and fails after verifyUntil", async () => {
    ses.on(GetEmailIdentityCommand).resolves({
      DkimAttributes: { Status: "PENDING", Tokens: ["t1", "t2", "t3"] },
      MailFromAttributes: {
        MailFromDomain: "bounce.slow.acme.com",
        MailFromDomainStatus: "PENDING",
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
      },
    });
    const { verifyDomain, createDomain } = await import("@/services/domains");
    const created = await createDomain(actor, { name: "slow.acme.com" }, noop);
    if (!created.ok) throw new Error(created.error);
    const enqueue = vi.fn(async () => "job");
    await verifyDomain(created.data.id, { enqueue, resolver: emptyDns });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      "domain.verify",
      { domainId: created.data.id },
      { startAfter: 120 },
    );
    expect((await byName("slow.acme.com")).status).toBe("pending");
    await pg.db
      .update(domains)
      .set({ verifyUntil: new Date(Date.now() - 1000) })
      .where(eq(domains.id, created.data.id));
    enqueue.mockClear();
    await verifyDomain(created.data.id, { enqueue, resolver: emptyDns });
    const after = await byName("slow.acme.com");
    expect(after.status).toBe("failed");
    expect(after.lastError).toMatch(/timed out/);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("reverifyDomain resets the window and runs one check now", async () => {
    const { reverifyDomain } = await import("@/services/domains");
    const d = await byName("slow.acme.com");
    const enqueue = vi.fn(async () => "job");
    expect(
      (await reverifyDomain({ ...actor, role: "member" }, d.id, { enqueue }))
        .ok,
    ).toBe(false);
    expect((await reverifyDomain(actor, d.id, { enqueue })).ok).toBe(true);
    const after = await byName("slow.acme.com");
    expect(after.status).toBe("pending");
    expect(after.lastError).toBeNull();
    expect(after.verifyUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(enqueue).toHaveBeenCalledWith("domain.verify", { domainId: d.id });
  });
  it("verifyDomain stops polling (no throw, no re-enqueue) when AWS is disconnected", async () => {
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    await updateInstanceSettings({ awsMode: "none" }, undefined, {
      audit: false,
    });
    const { verifyDomain } = await import("@/services/domains");
    const d = await byName("slow.acme.com");
    const enqueue = vi.fn(async () => "job");
    await verifyDomain(d.id, { enqueue, resolver: emptyDns });
    const after = await byName("slow.acme.com");
    expect(after.status).toBe("pending");
    expect(after.lastError).toMatch(/AWS is not connected/);
    expect(enqueue).not.toHaveBeenCalled();
    expect(ses.commandCalls(GetEmailIdentityCommand)).toHaveLength(0);
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
    const res = await deleteDomain(actor, d.id, { fetch: cfFetch });
    expect(res.ok).toBe(true);
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
