import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startPg } from "./_pg";
import { emails, type EmailEventType, type EmailStatus } from "@/db/schema";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
});
afterAll(async () => {
  await pg.stop();
});

let n = 0;
async function seed(status: EmailStatus = "queued") {
  const id = `em_test_${++n}`;
  await pg.db.insert(emails).values({
    id,
    teamId: "org_1",
    from: "a@mail.acme.com",
    fromEmail: "a@mail.acme.com",
    to: ["r@x.io"],
    subject: "s",
    status,
  });
  return id;
}
async function load(id: string) {
  const [e] = await pg.db.select().from(emails).where(eq(emails.id, id));
  return e!;
}
async function ev(
  emailId: string,
  type: EmailEventType,
  dedupeKey: string,
  occurredAt?: Date,
) {
  const { recordEvent } = await import("@/services/email-events");
  return recordEvent({ emailId, teamId: "org_1", type, dedupeKey, occurredAt });
}

describe("recordEvent", () => {
  it("duplicate dedupeKey returns null and leaves the status alone", async () => {
    const id = await seed();
    expect(await ev(id, "sent", "k")).not.toBeNull();
    expect((await load(id)).status).toBe("sent");
    expect(await ev(id, "bounced", "k")).toBeNull();
    expect((await load(id)).status).toBe("sent");
    const { listEvents } = await import("@/services/email-events");
    expect(await listEvents(id)).toHaveLength(1);
  });

  it("never regresses: sent after delivered, delivered after bounced", async () => {
    const id = await seed();
    await ev(id, "delivered", "d");
    await ev(id, "sent", "s");
    expect((await load(id)).status).toBe("delivered");
    const id2 = await seed();
    await ev(id2, "bounced", "b");
    await ev(id2, "delivered", "d");
    expect((await load(id2)).status).toBe("bounced");
  });

  it("delivery_delayed, opened and clicked are timeline-only", async () => {
    const id = await seed();
    // Distinct times: the timeline sorts by occurredAt, and two events
    // recorded in the same millisecond would tie.
    const t = (s: number) => new Date(Date.UTC(2026, 7, 25, 0, 0, s));
    await ev(id, "sent", "s", t(1));
    await ev(id, "delivery_delayed", "dd", t(2));
    await ev(id, "opened", "o", t(3));
    await ev(id, "clicked", "c", t(4));
    expect((await load(id)).status).toBe("sent");
    const { listEvents } = await import("@/services/email-events");
    expect((await listEvents(id)).map((e) => e.type)).toEqual([
      "sent",
      "delivery_delayed",
      "opened",
      "clicked",
    ]);
  });

  it("sentAt is set once, by the first sent event", async () => {
    const id = await seed();
    const first = new Date("2026-08-25T00:00:00Z");
    await ev(id, "sent", "s1", first);
    await ev(id, "sent", "s2", new Date("2026-08-25T01:00:00Z"));
    expect((await load(id)).sentAt?.toISOString()).toBe(first.toISOString());
  });

  it("cancelled only beats the pre-send states", async () => {
    const sent = await seed("sent");
    await ev(sent, "cancelled", "c");
    expect((await load(sent)).status).toBe("sent");
    const queued = await seed();
    await ev(queued, "cancelled", "c");
    expect((await load(queued)).status).toBe("cancelled");
  });
});
