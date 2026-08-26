import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  emailAttachments,
  emails,
  webhookDeliveries,
  webhooks,
} from "@/db/schema";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
const now = new Date("2026-08-25T03:15:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
  await pg.db.insert(webhooks).values({
    id: "wh_1",
    teamId: "org_1",
    url: "https://hooks.acme.com/x",
    secretEnc: "v1.x",
    events: ["email.delivered"],
  });
});
afterAll(async () => {
  await pg.stop();
});

async function seedEmail(id: string, createdAt: Date) {
  await pg.db.insert(emails).values({
    id,
    teamId: "org_1",
    from: "a@mail.acme.com",
    fromEmail: "a@mail.acme.com",
    to: ["r@x.io"],
    subject: "s",
    html: "<p>body</p>",
    text: "body",
    attachmentsMeta: [
      {
        id: `att_${id}`,
        filename: "a.txt",
        contentType: "text/plain",
        size: 2,
      },
    ],
    status: "sent",
    createdAt,
  });
  await pg.db.insert(emailAttachments).values({
    id: `att_${id}`,
    emailId: id,
    filename: "a.txt",
    contentType: "text/plain",
    size: 2,
    bytes: Buffer.from("hi"),
  });
}
async function seedDelivery(id: string, createdAt: Date) {
  await pg.db.insert(webhookDeliveries).values({
    id,
    webhookId: "wh_1",
    teamId: "org_1",
    eventId: `evt_${id}`,
    eventType: "email.delivered",
    payload: {},
    status: "delivered",
    createdAt,
  });
}
const load = async (id: string) =>
  (await pg.db.select().from(emails).where(eq(emails.id, id)))[0]!;
const attachmentsOf = (id: string) =>
  pg.db.select().from(emailAttachments).where(eq(emailAttachments.emailId, id));

describe("retention purge", () => {
  it("purges bodies and attachments of emails older than the window, keeps newer ones, and is idempotent", async () => {
    await seedEmail("em_old", daysAgo(91));
    await seedEmail("em_new", daysAgo(1));
    await seedDelivery("whd_old", daysAgo(91));
    await seedDelivery("whd_new", daysAgo(1));
    const { purgeOldBodies } = await import("@/services/retention");
    expect(await purgeOldBodies(90, now)).toEqual({ emails: 1, deliveries: 1 });

    const old = await load("em_old");
    expect(old).toMatchObject({
      html: null,
      text: null,
      subject: "s",
      status: "sent",
      bodyPurgedAt: now,
    });
    // Metadata stays so the log can still list what was attached.
    expect(old.attachmentsMeta).toHaveLength(1);
    expect(await attachmentsOf("em_old")).toHaveLength(0);

    const fresh = await load("em_new");
    expect(fresh).toMatchObject({ html: "<p>body</p>", bodyPurgedAt: null });
    expect(await attachmentsOf("em_new")).toHaveLength(1);

    expect(
      (await pg.db.select().from(webhookDeliveries)).map((d) => d.id),
    ).toEqual(["whd_new"]);

    // Second run: nothing left to purge.
    expect(await purgeOldBodies(90, now)).toEqual({ emails: 0, deliveries: 0 });
    expect((await load("em_old")).bodyPurgedAt).toEqual(now);
  });

  it("walks batches until none remain", async () => {
    for (let i = 0; i < 3; i++) await seedEmail(`em_b${i}`, daysAgo(100 + i));
    const { purgeOldBodies } = await import("@/services/retention");
    expect(await purgeOldBodies(90, now, 2)).toEqual({
      emails: 3,
      deliveries: 0,
    });
    for (let i = 0; i < 3; i++)
      expect((await load(`em_b${i}`)).bodyPurgedAt).toEqual(now);
  });

  it("purges the substituted variables along with the body", async () => {
    await pg.db.insert(emails).values({
      id: "em_vars",
      teamId: "org_1",
      from: "a@mail.acme.com",
      fromEmail: "a@mail.acme.com",
      to: ["r@x.io"],
      subject: "s",
      html: "<p>hi</p>",
      variables: { name: "Mingu", orderId: "1234" },
      createdAt: daysAgo(400),
    });
    const { purgeOldBodies } = await import("@/services/retention");
    await purgeOldBodies(90, now);
    const row = await load("em_vars");
    expect(row.html).toBeNull();
    // Variables hold whatever was substituted — names, order numbers,
    // addresses. A row whose body is gone but whose variables remain has not
    // been purged.
    expect(row.variables).toBeNull();
  });

  it("the job reads retention_days from instance settings", async () => {
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    await updateInstanceSettings({ retentionDays: 30 }, undefined, {
      audit: false,
    });
    // 45 days old: inside the default 90, outside the configured 30.
    await seedEmail("em_45", new Date(Date.now() - 45 * 86_400_000));
    const { runRetentionPurge } =
      await import("@/jobs/handlers/retention-purge");
    expect((await runRetentionPurge()).emails).toBe(1);
    expect((await load("em_45")).bodyPurgedAt).toBeInstanceOf(Date);
    expect((await load("em_new")).bodyPurgedAt).toBeNull();
  });
});
