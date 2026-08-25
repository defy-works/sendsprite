import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";
import { PassThrough } from "node:stream";
import nodemailer from "nodemailer";
import { startPg } from "./_pg";

// The relay ends in `createEmail`, which enqueues `email.send`; the job
// itself is covered by email-send.test.ts.
vi.mock("@/jobs/enqueue", () => ({ enqueue: vi.fn(async () => "job") }));

let pg: Awaited<ReturnType<typeof startPg>>;
let secret: string;
const port = 20000 + randomInt(1000);
const MAX_SIZE = 4096;

const transport = (pass: string, extra: { ignoreTLS?: boolean } = {}) =>
  nodemailer.createTransport({
    host: "127.0.0.1",
    port,
    secure: false,
    auth: { user: "sendsprite", pass },
    tls: { rejectUnauthorized: false },
    ...extra,
  });
const mail = { from: "a@mail.acme.com", to: "r@x.io", subject: "s", text: "t" };

beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
  (await import("@/env.schema")).resetEnvCache();
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
  const { domains } = await import("@/db/schema");
  await pg.db.insert(domains).values({
    id: "dom_1",
    teamId: "org_1",
    name: "mail.acme.com",
    region: "eu-west-1",
    dnsMode: "auto",
    mailFromDomain: "bounce.mail.acme.com",
    status: "verified",
    verifiedAt: new Date(),
    expectedRecords: [],
  });
  const { createApiKey } = await import("@/services/api-keys");
  const k = await createApiKey(
    { userId: "u1", teamId: "org_1", teamName: "Acme", role: "owner" },
    { name: "smtp" },
  );
  if (!k.ok) throw new Error("seed failed");
  secret = k.data.secret;
  const { startSmtp } = await import("@/smtp/server");
  await startSmtp({
    port,
    host: "127.0.0.1",
    tls: "selfsigned",
    maxSize: MAX_SIZE,
  });
});
afterAll(async () => {
  const { stopSmtp } = await import("@/smtp/server");
  await stopSmtp();
  await pg.stop();
});

const latest = async () => {
  const { listEmails } = await import("@/services/emails");
  return (await listEmails("org_1", { limit: 1 })).data[0]!;
};

describe("SMTP relay", () => {
  it("authenticates with an API key as password over STARTTLS and creates the email through the normal path", async () => {
    const t = transport(secret);
    const info = await t.sendMail({
      from: "Acme <hello@mail.acme.com>",
      to: "r@x.io",
      cc: "c@x.io",
      bcc: ["hidden@x.io", "R@x.io"],
      replyTo: "reply@mail.acme.com",
      subject: "Via SMTP",
      text: "hello",
      html: "<p>hello</p>",
      headers: { "X-Campaign": "launch" },
      attachments: [{ filename: "a.txt", content: "hi" }],
    });
    expect(info.response).toMatch(/^250/);
    t.close();

    const row = await latest();
    expect(row).toMatchObject({
      from: '"Acme" <hello@mail.acme.com>',
      fromEmail: "hello@mail.acme.com",
      to: ["r@x.io"],
      cc: ["c@x.io"],
      // Envelope recipients that are not in To/Cc; case-insensitive.
      bcc: ["hidden@x.io"],
      replyTo: ["reply@mail.acme.com"],
      subject: "Via SMTP",
      source: "smtp",
      text: "hello",
      headers: { "X-Campaign": "launch" },
      attachmentsMeta: [{ filename: "a.txt", contentType: "text/plain" }],
    });
    // Standard/reserved headers nodemailer adds never reach the pipeline.
    expect(Object.keys(row.headers)).toEqual(["X-Campaign"]);
    expect(row.html).toContain("<p>hello</p>");
    expect(row.apiKeyId).toMatch(/^key_/);
  });

  it("delivers to the envelope, not the headers: a To header outside RCPT TO is dropped", async () => {
    const t = transport(secret);
    const info = await t.sendMail({
      from: "a@mail.acme.com",
      to: "customer@x.io",
      subject: "forwarded to me",
      text: "t",
      envelope: { from: "a@mail.acme.com", to: ["me@x.io"] },
    });
    expect(info.response).toMatch(/^250/);
    t.close();
    const row = await latest();
    expect(row).toMatchObject({
      subject: "forwarded to me",
      to: ["me@x.io"],
      cc: [],
      bcc: [],
    });
    expect(JSON.stringify(row)).not.toContain("customer@x.io");
  });

  it("refuses AUTH on a plain connection (STARTTLS required by default)", async () => {
    await expect(
      transport(secret, { ignoreTLS: true }).sendMail(mail),
    ).rejects.toThrow(/538/);
    const { emails } = await import("@/db/schema");
    expect((await pg.db.select().from(emails)).length).toBe(2);
  });

  it("rejects a bad API key with 535", async () => {
    await expect(
      transport("ss_live_" + "b".repeat(24)).sendMail(mail),
    ).rejects.toThrow(/535/);
  });

  it("returns 550 for an unverified from domain and 501 without a body; defaults a missing subject", async () => {
    const t = transport(secret);
    await expect(t.sendMail({ ...mail, from: "a@nope.io" })).rejects.toThrow(
      /550/,
    );
    await expect(
      t.sendMail({
        from: "a@mail.acme.com",
        to: "r@x.io",
        subject: "s",
        attachments: [{ filename: "a.txt", content: "hi" }],
      }),
    ).rejects.toThrow(/501/);
    await t.sendMail({ from: "a@mail.acme.com", to: "r@x.io", text: "t" });
    expect((await latest()).subject).toBe("(no subject)");
    t.close();
  });

  it("returns 552 for an oversized message without buffering it, and the connection stays usable", async () => {
    const t = transport(secret, {});
    await expect(
      t.sendMail({ ...mail, text: "x".repeat(MAX_SIZE * 2) }),
    ).rejects.toThrow(/552/);
    const info = await t.sendMail({ ...mail, subject: "after overflow" });
    expect(info.response).toMatch(/^250/);
    expect((await latest()).subject).toBe("after overflow");
    t.close();
  });

  it("boundedBody stops feeding the parser at the size limit and drains the rest", async () => {
    const { boundedBody } = await import("@/smtp/inbound");
    const input = Object.assign(new PassThrough(), {
      byteLength: 0,
      sizeExceeded: false,
    });
    const { body, exceeded } = boundedBody(input);
    let fed = 0;
    body.on("data", (c: Buffer) => (fed += c.length));
    body.on("error", () => undefined);
    const chunk = Buffer.alloc(1024, "a");
    input.write(chunk);
    input.write(chunk);
    input.sizeExceeded = true; // smtp-server flips this as bytes arrive
    input.write(chunk);
    input.write(chunk);
    input.end();
    await expect(exceeded).rejects.toMatchObject({ responseCode: 552 });
    await new Promise((r) => input.once("end", r));
    expect(fed).toBe(2048);
    expect(body.destroyed).toBe(true);
  });

  it("locks an address out after 5 failed logins, even with a valid key", async () => {
    const { resetLoginThrottle } = await import("@/smtp/server");
    resetLoginThrottle();
    for (let i = 0; i < 5; i++)
      await expect(
        transport("ss_live_" + "c".repeat(24)).sendMail(mail),
      ).rejects.toThrow(/535 Invalid API key/);
    await expect(transport(secret).sendMail(mail)).rejects.toThrow(
      /535 Too many failed logins/,
    );
    resetLoginThrottle();
    const info = await transport(secret).sendMail(mail);
    expect(info.response).toMatch(/^250/);
  });

  it("stops promptly with an idle connection open", async () => {
    const { startSmtp, stopSmtp } = await import("@/smtp/server");
    const t = transport(secret);
    await t.verify(); // opens and keeps a connection
    const started = Date.now();
    await stopSmtp();
    expect(Date.now() - started).toBeLessThan(6000);
    t.close();
    await startSmtp({
      port,
      host: "127.0.0.1",
      tls: "selfsigned",
      maxSize: MAX_SIZE,
    });
  });
});
