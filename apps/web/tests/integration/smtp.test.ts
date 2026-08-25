import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt } from "node:crypto";
import nodemailer from "nodemailer";
import { startPg } from "./_pg";

// The relay ends in `createEmail`, which enqueues `email.send`; the job
// itself is covered by email-send.test.ts.
vi.mock("@/jobs/enqueue", () => ({ enqueue: vi.fn(async () => "job") }));

let pg: Awaited<ReturnType<typeof startPg>>;
let secret: string;
const port = 20000 + randomInt(1000);

const transport = (pass: string) =>
  nodemailer.createTransport({
    host: "127.0.0.1",
    port,
    secure: false,
    auth: { user: "sendsprite", pass },
    tls: { rejectUnauthorized: false },
  });

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
    maxSize: 4096,
  });
});
afterAll(async () => {
  const { stopSmtp } = await import("@/smtp/server");
  await stopSmtp();
  await pg.stop();
});

describe("SMTP relay", () => {
  it("authenticates with an API key as password over STARTTLS and creates the email through the normal path", async () => {
    const t = transport(secret);
    const info = await t.sendMail({
      from: "Acme <hello@mail.acme.com>",
      to: "r@x.io",
      cc: "c@x.io",
      replyTo: "reply@mail.acme.com",
      subject: "Via SMTP",
      text: "hello",
      html: "<p>hello</p>",
      headers: { "X-Campaign": "launch" },
      attachments: [{ filename: "a.txt", content: "hi" }],
    });
    expect(info.response).toMatch(/^250/);
    t.close();

    const { listEmails } = await import("@/services/emails");
    const { data } = await listEmails("org_1", { limit: 1 });
    expect(data[0]).toMatchObject({
      from: '"Acme" <hello@mail.acme.com>',
      fromEmail: "hello@mail.acme.com",
      to: ["r@x.io"],
      cc: ["c@x.io"],
      replyTo: ["reply@mail.acme.com"],
      subject: "Via SMTP",
      source: "smtp",
      text: "hello",
      headers: { "X-Campaign": "launch" },
      attachmentsMeta: [{ filename: "a.txt", contentType: "text/plain" }],
    });
    // Standard/reserved headers nodemailer adds never reach the pipeline.
    expect(Object.keys(data[0]!.headers)).toEqual(["X-Campaign"]);
    expect(data[0]!.html).toContain("<p>hello</p>");
    expect(data[0]!.apiKeyId).toMatch(/^key_/);
  });

  it("rejects a bad API key with 535", async () => {
    await expect(
      transport("ss_live_" + "b".repeat(24)).sendMail({
        from: "a@mail.acme.com",
        to: "r@x.io",
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow(/535/);
  });

  it("returns 550 for an unverified from domain and 501 without a body", async () => {
    const t = transport(secret);
    await expect(
      t.sendMail({
        from: "a@nope.io",
        to: "r@x.io",
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow(/550/);
    await expect(
      t.sendMail({
        from: "a@mail.acme.com",
        to: "r@x.io",
        subject: "s",
        attachments: [{ filename: "a.txt", content: "hi" }],
      }),
    ).rejects.toThrow(/501/);
    t.close();
  });

  it("returns 552 for an oversized message", async () => {
    await expect(
      transport(secret).sendMail({
        from: "a@mail.acme.com",
        to: "r@x.io",
        subject: "s",
        text: "x".repeat(8192),
      }),
    ).rejects.toThrow(/552/);
  });

  it("locks an address out after 5 failed logins, even with a valid key", async () => {
    const { resetLoginThrottle } = await import("@/smtp/server");
    resetLoginThrottle();
    const mail = {
      from: "a@mail.acme.com",
      to: "r@x.io",
      subject: "s",
      text: "t",
    };
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
});
