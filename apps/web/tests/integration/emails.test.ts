import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "http://localhost:3000";
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
  const { domains } = await import("@/db/schema");
  await pg.db.insert(domains).values({
    id: "dom_1",
    teamId: "org_1",
    name: "mail.acme.com",
    region: "eu-west-1",
    dnsMode: "manual",
    mailFromDomain: "bounce.mail.acme.com",
    status: "verified",
  });
});
afterAll(async () => {
  await pg.stop();
});

const ctx = {
  teamId: "org_1",
  source: "api" as const,
  apiKeyId: "key_1",
  actorUserId: null,
};
const actor = {
  userId: "u1",
  teamId: "org_1",
  teamName: "Acme",
  role: "admin" as const,
};
const base = {
  from: "a@mail.acme.com",
  to: ["r@x.io"],
  subject: "s",
  text: "t",
};

describe("createEmail", () => {
  it("validates, resolves the verified domain, applies tracking, stores attachments, records queued event, enqueues", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createEmail } = await import("@/services/emails");
    const res = await createEmail(
      ctx,
      {
        from: "Acme <hello@mail.acme.com>",
        to: ["r@x.io"],
        subject: "Hi",
        html: '<p><a href="https://x.io">x</a></p>',
        attachments: [
          { filename: "a.txt", content: Buffer.from("hi").toString("base64") },
        ],
        tags: { k: "v" },
      },
      { enqueue },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const e = res.data;
    expect(e).toMatchObject({
      status: "queued",
      domainId: "dom_1",
      fromEmail: "hello@mail.acme.com",
      attachmentsMeta: [{ filename: "a.txt", size: 2 }],
      trackOpens: true,
      trackClicks: true,
    });
    expect(e.html).toContain("/t/c/" + e.id);
    expect(e.html).toContain(`/t/o/${e.id}.gif`);
    expect(enqueue).toHaveBeenCalledWith(
      "email.send",
      { emailId: e.id },
      undefined,
    );
    const { listEvents } = await import("@/services/email-events");
    expect((await listEvents(e.id)).map((x) => x.type)).toEqual(["queued"]);
    const { emailAttachments } = await import("@/db/schema");
    const [att] = await pg.db.select().from(emailAttachments);
    expect(att).toMatchObject({
      emailId: e.id,
      filename: "a.txt",
      contentType: "application/octet-stream",
      size: 2,
    });
    expect(Buffer.from(att!.bytes).toString()).toBe("hi");
  });

  it("rejects unverified/foreign domains, suppressed recipients (unless manual+override), reserved headers, caps", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createEmail } = await import("@/services/emails");
    expect(
      await createEmail(ctx, { ...base, from: "a@unknown.io" }, { enqueue }),
    ).toMatchObject({ ok: false, code: "domain_not_verified" });
    expect(
      await createEmail(
        ctx,
        { ...base, headers: { From: "x@y.io" } },
        { enqueue },
      ),
    ).toMatchObject({ ok: false, code: "validation_error" });
    // A template this team does not have names the slug and the field, so
    // the customer's next action is obvious from the message alone.
    expect(
      await createEmail(
        ctx,
        { ...base, text: undefined, template: "welcome" },
        { enqueue },
      ),
    ).toMatchObject({
      ok: false,
      code: "validation_error",
      error: expect.stringContaining('"welcome"'),
      details: { field: "template" },
    });
    const { suppressFromEvent, addSuppression } =
      await import("@/services/suppressions");
    await suppressFromEvent(
      "org_1",
      [{ email: "bounced@x.io", reason: "bounce" }],
      null,
    );
    expect(
      await createEmail(
        ctx,
        { ...base, to: ["bounced@x.io"], overrideSuppression: true },
        { enqueue },
      ),
    ).toMatchObject({ ok: false, code: "suppressed_recipient" });
    await addSuppression(actor, { email: "manual@x.io", reason: "manual" });
    expect(
      await createEmail(ctx, { ...base, to: ["manual@x.io"] }, { enqueue }),
    ).toMatchObject({ ok: false, code: "suppressed_recipient" });
    expect(
      (
        await createEmail(
          ctx,
          { ...base, to: ["manual@x.io"], overrideSuppression: true },
          { enqueue },
        )
      ).ok,
    ).toBe(true);
    // A sending-only key cannot override even a manual suppression.
    expect(
      await createEmail(
        { ...ctx, permission: "sending_only" },
        { ...base, to: ["manual@x.io"], overrideSuppression: true },
        { enqueue },
      ),
    ).toMatchObject({ ok: false, code: "suppressed_recipient" });
    expect(
      (
        await createEmail(
          { ...ctx, permission: "full" },
          { ...base, to: ["manual@x.io"], overrideSuppression: true },
          { enqueue },
        )
      ).ok,
    ).toBe(true);
    // Team caps: daily limit 2 with two active emails already created above.
    const { teamSettings } = await import("@/db/schema");
    await pg.db.insert(teamSettings).values({ teamId: "org_1", dailyLimit: 2 });
    expect(await createEmail(ctx, base, { enqueue })).toMatchObject({
      ok: false,
      code: "daily_quota_exceeded",
    });
    await pg.db.delete(teamSettings);
  });

  it("scheduled sends enqueue with startAfter and status scheduled; idempotency returns the same id; conflict on different payload", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createEmail } = await import("@/services/emails");
    const when = new Date(Date.now() + 3600_000).toISOString();
    const a = await createEmail(
      ctx,
      { ...base, scheduledAt: when, idempotencyKey: "k1" },
      { enqueue },
    );
    expect(a).toMatchObject({ ok: true, data: { status: "scheduled" } });
    expect(enqueue).toHaveBeenCalledWith("email.send", expect.anything(), {
      startAfter: expect.any(Number),
    });
    const b = await createEmail(
      ctx,
      { ...base, scheduledAt: when, idempotencyKey: "k1" },
      { enqueue },
    );
    expect(b.ok && a.ok && b.data.id === a.data.id).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(
      await createEmail(
        ctx,
        { ...base, to: ["other@x.io"], idempotencyKey: "k1" },
        { enqueue },
      ),
    ).toMatchObject({ ok: false, code: "idempotency_conflict" });
    // The key is checked before the domain: an unverified domain still
    // returns the row a retry already created.
    const { domains } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await pg.db
      .update(domains)
      .set({ status: "pending" })
      .where(eq(domains.id, "dom_1"));
    const c = await createEmail(
      ctx,
      { ...base, scheduledAt: when, idempotencyKey: "k1" },
      { enqueue },
    );
    expect(c.ok && a.ok && c.data.id === a.data.id).toBe(true);
    await pg.db
      .update(domains)
      .set({ status: "verified" })
      .where(eq(domains.id, "dom_1"));
    // The fingerprint covers the body too, not just subject + to.
    expect(
      await createEmail(
        ctx,
        { ...base, text: "different", idempotencyKey: "k1" },
        { enqueue },
      ),
    ).toMatchObject({ ok: false, code: "idempotency_conflict" });
  });

  it("cancel works for queued/scheduled only; reschedule updates scheduledAt", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createEmail, cancelEmail, rescheduleEmail, getEmail } =
      await import("@/services/emails");
    const { listEvents, recordEvent } = await import("@/services/email-events");
    const when = new Date(Date.now() + 3600_000).toISOString();
    const created = await createEmail(
      ctx,
      { ...base, scheduledAt: when },
      { enqueue },
    );
    if (!created.ok) throw new Error(created.error);
    const id = created.data.id;

    // Reschedule while scheduled: new time + a fresh delayed job.
    const later = new Date(Date.now() + 7200_000).toISOString();
    const r = await rescheduleEmail("org_1", id, later, { enqueue });
    expect(r).toMatchObject({ ok: true, data: { status: "scheduled" } });
    if (!r.ok) throw new Error(r.error);
    expect(r.data.scheduledAt?.toISOString()).toBe(later);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenLastCalledWith(
      "email.send",
      { emailId: id },
      { startAfter: expect.any(Number) },
    );
    expect(
      await rescheduleEmail("org_1", id, "not-a-date", { enqueue }),
    ).toMatchObject({ ok: false, code: "validation_error" });
    expect(
      await rescheduleEmail("org_other", id, later, { enqueue }),
    ).toMatchObject({ ok: false, code: "not_found" });

    const moved = await listEvents(id);
    expect(moved.map((x) => x.type)).toEqual(["queued", "queued"]);
    expect(moved[1]!.payload).toEqual({ rescheduledTo: later });

    const c = await cancelEmail("org_1", id, "u1");
    expect(c).toMatchObject({ ok: true, data: { status: "cancelled" } });
    expect((await listEvents(id)).map((x) => x.type)).toEqual([
      "queued",
      "queued",
      "cancelled",
    ]);
    expect(await cancelEmail("org_1", id, "u1")).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(await cancelEmail("org_other", id, "u1")).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(
      await rescheduleEmail("org_1", id, later, { enqueue }),
    ).toMatchObject({ ok: false, code: "conflict" });

    // A sent email can neither be cancelled nor rescheduled.
    const sent = await createEmail(ctx, base, { enqueue });
    if (!sent.ok) throw new Error(sent.error);
    await recordEvent({
      emailId: sent.data.id,
      teamId: "org_1",
      type: "sent",
      dedupeKey: "local:test:sent",
    });
    expect((await getEmail("org_1", sent.data.id))?.status).toBe("sent");
    expect(await cancelEmail("org_1", sent.data.id, "u1")).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(
      await rescheduleEmail("org_1", sent.data.id, later, { enqueue }),
    ).toMatchObject({ ok: false, code: "conflict" });
  });

  it("a failing enqueue does not fail the request: the row is created and left to the queued sweep", async () => {
    const { createEmail } = await import("@/services/emails");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await createEmail(ctx, base, {
        enqueue: async () => {
          throw new Error("pg-boss down");
        },
      });
      expect(res).toMatchObject({ ok: true, created: true });
      if (!res.ok) return;
      expect(res.data.status).toBe("queued");
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("sending-only key scoped to a domain cannot send from another domain", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createEmail } = await import("@/services/emails");
    expect(
      await createEmail({ ...ctx, keyDomainId: "dom_other" }, base, {
        enqueue,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(enqueue).not.toHaveBeenCalled();
    expect(
      (await createEmail({ ...ctx, keyDomainId: "dom_1" }, base, { enqueue }))
        .ok,
    ).toBe(true);
  });
});

describe("createBatch", () => {
  it("creates every item in order; a failure reports its index and keeps earlier rows", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createBatch, getEmail } = await import("@/services/emails");
    const ok = await createBatch(
      ctx,
      [
        { ...base, subject: "b1" },
        { ...base, subject: "b2" },
      ],
      { enqueue },
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.data).toHaveLength(2);
    expect((await getEmail("org_1", ok.data[0]!.id))?.subject).toBe("b1");
    expect(enqueue).toHaveBeenCalledTimes(2);

    const bad = await createBatch(
      ctx,
      [
        { ...base, subject: "ok" },
        { ...base, from: "a@unknown.io" },
        { ...base, subject: "never" },
      ],
      { enqueue },
    );
    expect(bad).toMatchObject({
      ok: false,
      code: "domain_not_verified",
      details: { index: 1 },
    });
    expect(enqueue).toHaveBeenCalledTimes(3); // the first item still went out
    expect(await createBatch(ctx, [], { enqueue })).toMatchObject({
      ok: false,
      code: "validation_error",
    });
  });
});

/** `listEmails` unwrapped: the tests below only care about the page. */
async function pageOf() {
  const { listEmails } = await import("@/services/emails");
  return async (...args: Parameters<typeof listEmails>) => {
    const r = await listEmails(...args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
}

describe("listEmails", () => {
  it("does not skip rows sharing a millisecond across pages", async () => {
    const listEmails = await pageOf();
    const { emails } = await import("@/db/schema");
    await pg.db.execute(
      `insert into "organization"(id,name,slug,created_at) values ('org_3','Gamma','gamma',now())`,
    );
    const createdAt = new Date("2026-08-25T00:00:00.123Z");
    const row = (id: string) => ({
      id,
      teamId: "org_3",
      from: "a@mail.acme.com",
      fromEmail: "a@mail.acme.com",
      to: ["r@x.io"],
      subject: "s",
      createdAt,
    });
    await pg.db.insert(emails).values([row("em_same_a"), row("em_same_b")]);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listEmails("org_3", { limit: 1, cursor });
      seen.push(...page.data.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(["em_same_b", "em_same_a"]);
  });

  it("paginates with a keyset cursor and filters by status, to, domain and tag", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createEmail, listEmails: rawList } =
      await import("@/services/emails");
    const listEmails = await pageOf();
    const team = { ...ctx, teamId: "org_2" };
    await pg.db.execute(
      `insert into "organization"(id,name,slug,created_at) values ('org_2','Beta','beta',now())`,
    );
    const { domains } = await import("@/db/schema");
    await pg.db.insert(domains).values({
      id: "dom_2",
      teamId: "org_2",
      name: "mail.beta.com",
      region: "eu-west-1",
      dnsMode: "manual",
      mailFromDomain: "bounce.mail.beta.com",
      status: "verified",
    });
    const ids: string[] = [];
    for (const [i, to] of ["p1@x.io", "p2@x.io", "p3@x.io"].entries()) {
      const r = await createEmail(
        team,
        {
          ...base,
          from: "a@mail.beta.com",
          to: [to],
          tags: { n: String(i) },
          ...(i === 2 && {
            scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
          }),
        },
        { enqueue },
      );
      if (!r.ok) throw new Error(r.error);
      ids.push(r.data.id);
    }
    const page1 = await listEmails("org_2", { limit: 2 });
    expect(page1.data.map((e) => e.id)).toEqual([ids[2], ids[1]]);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listEmails("org_2", {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.data.map((e) => e.id)).toEqual([ids[0]]);
    expect(page2.nextCursor).toBeNull();
    expect(await rawList("org_2", { limit: 10, cursor: "garbage" })).toEqual({
      ok: false,
      error: "Invalid cursor.",
    });

    const byStatus = await listEmails("org_2", {
      limit: 10,
      status: "scheduled",
    });
    expect(byStatus.data.map((e) => e.id)).toEqual([ids[2]]);
    expect(
      (await listEmails("org_2", { limit: 10, to: "p2@x.io" })).data.map(
        (e) => e.id,
      ),
    ).toEqual([ids[1]]);
    expect(
      (await listEmails("org_2", { limit: 10, tag: "n:0" })).data.map(
        (e) => e.id,
      ),
    ).toEqual([ids[0]]);
    expect(
      (await listEmails("org_2", { limit: 10, domainId: "dom_2" })).data,
    ).toHaveLength(3);
    expect(
      (await listEmails("org_2", { limit: 10, domainId: "dom_1" })).data,
    ).toHaveLength(0);
    // Team isolation: org_1's rows never leak.
    expect(
      (await listEmails("org_2", { limit: 100 })).data.every(
        (e) => e.teamId === "org_2",
      ),
    ).toBe(true);
  });
});

describe("prepareDetail", () => {
  it("strips our pixel and click rewrites from the stored html", async () => {
    const { createEmail } = await import("@/services/emails");
    const { prepareDetail } = await import("@/lib/email-detail");
    const res = await createEmail(
      ctx,
      { ...base, html: '<p><a href="https://x.io/p?a=1&b=2">x</a></p>' },
      { enqueue: async () => "job" },
    );
    if (!res.ok) throw new Error(res.error);
    expect(res.data.html).toContain("/t/c/");
    const d = prepareDetail(res.data, "http://localhost:3000");
    expect(d.purged).toBe(false);
    expect(d.html).not.toContain("/t/o/");
    expect(d.html).not.toContain("/t/c/");
    expect(d.html).toContain('href="https://x.io/p?a=1&amp;b=2"');
    expect(
      prepareDetail({ ...res.data, bodyPurgedAt: new Date() }, "x"),
    ).toEqual({
      html: null,
      text: null,
      purged: true,
    });
  });
});

/**
 * A fresh team with its own verified sending domain. Templates are unique
 * per team by slug, so each template test owns its own slug space and the
 * tests below can all reach for "welcome".
 */
async function seedVerifiedDomain() {
  const { seedTeamWithKey } = await import("./helpers");
  const { team, actor } = await seedTeamWithKey();
  const { domains } = await import("@/db/schema");
  const name = `mail.${team.slug}.io`;
  await pg.db.insert(domains).values({
    id: `dom_${team.slug}`,
    teamId: team.id,
    name,
    region: "eu-west-1",
    dnsMode: "manual",
    mailFromDomain: `bounce.${name}`,
    status: "verified",
  });
  return { actor, team, from: `hello@${name}` };
}

describe("sending with a template", () => {
  const sendCtx = (teamId: string) => ({
    teamId,
    source: "api" as const,
    apiKeyId: null,
    actorUserId: null,
  });

  it("renders server-side and stores the result, the template id and the variables", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createEmail } = await import("@/services/emails");
    const { createTemplate } = await import("@/services/templates");
    const { actor, team, from } = await seedVerifiedDomain();
    const t = await createTemplate(actor, {
      slug: "welcome",
      name: "Welcome",
      subject: "Hi {{name}}",
      bodyHtml: "<p>Hello {{name}}</p>",
      bodyText: "Hello {{name}}",
    });
    if (!t.ok) throw new Error("seed failed");
    const res = await createEmail(
      sendCtx(team.id),
      {
        from,
        to: "c@d.io",
        template: "welcome",
        variables: { name: "<Mingu>" },
      },
      { enqueue },
    );
    if (!res.ok) throw new Error(`send failed: ${res.error}`);
    expect(res.data.subject).toBe("Hi <Mingu>");
    // Escaped in html, raw in text — the field decides, not the caller.
    expect(res.data.html).toContain("Hello &lt;Mingu&gt;");
    expect(res.data.text).toBe("Hello <Mingu>");
    expect(res.data.templateId).toBe(t.data.id);
    expect(res.data.variables).toEqual({ name: "<Mingu>" });
  });

  it("lets a request-level subject win over the template's", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createEmail } = await import("@/services/emails");
    const { createTemplate } = await import("@/services/templates");
    const { actor, team, from } = await seedVerifiedDomain();
    await createTemplate(actor, {
      slug: "welcome",
      name: "W",
      subject: "From the template",
      bodyHtml: "<p>x</p>",
    });
    const res = await createEmail(
      sendCtx(team.id),
      { from, to: "c@d.io", template: "welcome", subject: "From the request" },
      { enqueue },
    );
    if (!res.ok) throw new Error(`send failed: ${res.error}`);
    expect(res.data.subject).toBe("From the request");
  });

  it("refuses an unknown template and a template whose variables are missing", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createEmail } = await import("@/services/emails");
    const { createTemplate } = await import("@/services/templates");
    const { actor, team, from } = await seedVerifiedDomain();
    await createTemplate(actor, {
      slug: "welcome",
      name: "W",
      subject: "Hi {{name}}",
      bodyHtml: "<p>{{name}}</p>",
    });
    const missingTemplate = await createEmail(
      sendCtx(team.id),
      { from, to: "c@d.io", template: "nope" },
      { enqueue },
    );
    expect(missingTemplate).toMatchObject({
      ok: false,
      code: "validation_error",
      details: { field: "template" },
    });
    expect(missingTemplate.ok ? "" : missingTemplate.error).toContain("nope");
    const missingVariable = await createEmail(
      sendCtx(team.id),
      { from, to: "c@d.io", template: "welcome" },
      { enqueue },
    );
    expect(missingVariable).toMatchObject({
      ok: false,
      code: "validation_error",
    });
    expect(
      (missingVariable as { details: { missing: string[] } }).details.missing,
    ).toEqual(["name"]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a rendered subject carrying a line break", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createEmail } = await import("@/services/emails");
    const { createTemplate } = await import("@/services/templates");
    const { actor, team, from } = await seedVerifiedDomain();
    await createTemplate(actor, {
      slug: "inject",
      name: "I",
      subject: "Hi {{name}}",
      bodyHtml: "<p>x</p>",
    });
    const res = await createEmail(
      sendCtx(team.id),
      {
        from,
        to: "c@d.io",
        template: "inject",
        variables: { name: "x\r\nBcc: evil@x.io" },
      },
      { enqueue },
    );
    expect(res).toMatchObject({ ok: false, code: "validation_error" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("replays an idempotent template send, and conflicts once the template changed", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createEmail } = await import("@/services/emails");
    const { createTemplate, updateTemplate } =
      await import("@/services/templates");
    const { actor, team, from } = await seedVerifiedDomain();
    await createTemplate(actor, {
      slug: "welcome",
      name: "W",
      subject: "Hi",
      bodyHtml: "<p>v1</p>",
    });
    const body = {
      from,
      to: "c@d.io",
      template: "welcome",
      idempotencyKey: "k1",
    };
    const first = await createEmail(sendCtx(team.id), body, { enqueue });
    if (!first.ok) throw new Error(`send failed: ${first.error}`);
    // The replay only matches because the render happened *before* the
    // idempotency lookup: the fingerprint is over rendered bytes on both.
    const replay = await createEmail(sendCtx(team.id), body, { enqueue });
    if (!replay.ok) throw new Error(`replay failed: ${replay.error}`);
    expect(replay.created).toBe(false);
    expect(replay.data.id).toBe(first.data.id);
    expect(enqueue).toHaveBeenCalledTimes(1);
    // And once the template moves on, the same key is a conflict rather than
    // a silent return of an email whose body no longer matches the request.
    expect(
      (await updateTemplate(actor, "welcome", { bodyHtml: "<p>v2</p>" })).ok,
    ).toBe(true);
    expect(
      await createEmail(sendCtx(team.id), body, { enqueue }),
    ).toMatchObject({ ok: false, code: "idempotency_conflict" });
  });
});
