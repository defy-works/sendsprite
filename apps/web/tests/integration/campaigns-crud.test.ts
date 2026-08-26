import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

/**
 * A team with one verified sending domain and one contact book.
 *
 * Ids are suffixed per call so a test can seed two teams and hand one team's
 * book id to the other — which is the leak `checkRefs` exists to stop.
 */
async function seedTeam(status: "verified" | "pending" = "verified") {
  const { db } = await import("@/db");
  const { contactBooks, domains } = await import("@/db/schema");
  const { actor, team } = await seedTeamWithKey();
  const suffix = randomBytes(4).toString("hex");
  const domainName = `${suffix}.example.test`;
  const domainId = `dom_${suffix}`;
  const bookId = `cb_${suffix}`;
  await db()
    .insert(domains)
    .values({
      id: domainId,
      teamId: team.id,
      name: domainName,
      region: "eu-west-1",
      dnsMode: "manual",
      status,
      mailFromDomain: `bounce.${domainName}`,
    });
  await db()
    .insert(contactBooks)
    .values({ id: bookId, teamId: team.id, name: "News" });
  return {
    actor,
    team,
    bookId,
    domainId,
    domainName,
    from: `news@${domainName}`,
    draft: {
      name: "August news",
      bookId,
      domainId,
      from: `news@${domainName}`,
      subject: "Hello",
      blocks: [{ kind: "text", html: "Hi" }],
    },
  };
}

const svc = () => import("@/services/campaigns/crud");

/** Drops a campaign into a status the service will not create it in. */
async function forceStatus(id: string, status: string) {
  const { db } = await import("@/db");
  const { campaigns } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  await db()
    .update(campaigns)
    .set({ status: status as "sending" })
    .where(eq(campaigns.id, id));
}

async function createDraft() {
  const seed = await seedTeam();
  const created = await (await svc()).createCampaign(seed.actor, seed.draft);
  if (!created.ok) throw new Error(`seed create failed: ${created.error}`);
  return { ...seed, campaign: created.data };
}

describe("campaign CRUD", () => {
  it("creates a draft with zeroed counts and a `cmp_` id", async () => {
    const { actor, draft, bookId, domainId } = await seedTeam();
    const created = await (await svc()).createCampaign(actor, draft);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    expect(created.data.id).toMatch(/^cmp_/);
    expect(created.data.status).toBe("draft");
    expect(created.data.bookId).toBe(bookId);
    expect(created.data.domainId).toBe(domainId);
    expect(created.data.createdBy).toBe(actor.userId);
    // The count cache starts as the honest all-zero answer, not `{}`.
    expect(created.data.counts).toEqual({
      recipients: 0,
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      unsubscribed: 0,
      bounced: 0,
      complained: 0,
      failed: 0,
    });
  });

  it("writes an audit row naming the campaign", async () => {
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { actor, campaign } = await createDraft();
    const rows = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.teamId, actor.teamId));
    const created = rows.find((r) => r.action === "campaigns.create");
    expect(created).toBeTruthy();
    expect(created!.targetType).toBe("campaign");
    expect(created!.targetId).toBe(campaign.id);
    expect(created!.actorUserId).toBe(actor.userId);
    expect(created!.diff).toMatchObject({ name: { to: "August news" } });
  });

  /*
   * The data-leak test. `campaigns.book_id` has no foreign key, so nothing
   * below this service stops a campaign naming another team's contact book —
   * and a campaign that reaches the fan-out with one mails that team's
   * contacts.
   */
  it("refuses a book from another team", async () => {
    const mine = await seedTeam();
    const theirs = await seedTeam();
    const res = await (
      await svc()
    ).createCampaign(mine.actor, { ...mine.draft, bookId: theirs.bookId });
    expect(res).toMatchObject({ ok: false, code: "validation_error" });
    if (res.ok) throw new Error("unreachable");
    // The same answer an unknown id gets: whether that book exists elsewhere
    // is not this team's business.
    expect(res.error).toBe("Contact book not found.");
    const page = await (await svc()).listCampaignsPage(mine.actor.teamId);
    if (!page.ok) throw new Error("unreachable");
    expect(page.data.data).toHaveLength(0);
  });

  it("refuses a domain from another team", async () => {
    const mine = await seedTeam();
    const theirs = await seedTeam();
    const res = await (
      await svc()
    ).createCampaign(mine.actor, {
      ...mine.draft,
      domainId: theirs.domainId,
      from: theirs.from,
    });
    expect(res).toMatchObject({ ok: false, code: "validation_error" });
  });

  it("refuses a domain that is not verified", async () => {
    const seed = await seedTeam("pending");
    const res = await (await svc()).createCampaign(seed.actor, seed.draft);
    expect(res).toMatchObject({ ok: false, code: "domain_not_verified" });
  });

  it("refuses a from-address that is not at the named domain", async () => {
    const seed = await seedTeam();
    const res = await (
      await svc()
    ).createCampaign(seed.actor, {
      ...seed.draft,
      from: "news@somewhere-else.test",
    });
    expect(res).toMatchObject({ ok: false, code: "domain_not_verified" });
  });

  it("refuses a member without campaigns.manage", async () => {
    const seed = await seedTeam();
    const member = { ...seed.actor, role: "member" as const };
    expect(
      await (await svc()).createCampaign(member, seed.draft),
    ).toMatchObject({ ok: false, code: "forbidden" });
    const { campaign } = await createDraft();
    expect(
      await (await svc()).updateCampaign(member, campaign.id, { name: "x" }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      await (await svc()).deleteCampaign(member, campaign.id),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  /*
   * Ordering, not just outcome: a forbidden actor asking about an id that
   * does not exist must get `forbidden`, never `not_found`. Otherwise the
   * error shape is an oracle for which campaign ids are real.
   */
  it("checks the permission before the lookup", async () => {
    const seed = await seedTeam();
    const member = { ...seed.actor, role: "member" as const };
    const nobody = "cmp_00000000000000000000000000";
    expect(
      await (await svc()).updateCampaign(member, nobody, { name: "x" }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(await (await svc()).deleteCampaign(member, nobody)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    // And an owner really does get `not_found` for the same id, so the test
    // above is not passing because everything returns `forbidden`.
    expect(
      await (await svc()).updateCampaign(seed.actor, nobody, { name: "x" }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("edits a draft", async () => {
    const { actor, campaign } = await createDraft();
    const res = await (
      await svc()
    ).updateCampaign(actor, campaign.id, {
      name: "September news",
      blocks: [{ kind: "heading", level: 1, text: "Hi" }],
    });
    if (!res.ok) throw new Error(`unreachable: ${res.error}`);
    expect(res.data.name).toBe("September news");
    expect(res.data.blocks).toEqual([
      { kind: "heading", level: 1, text: "Hi" },
    ]);
    expect(res.data.status).toBe("draft");
  });

  /*
   * The load-bearing pair. Editing the blocks of a half-sent campaign means
   * the first 10 000 recipients got one mail and the rest got another, under
   * one name and one set of stats.
   */
  it("refuses to edit a campaign that is sending", async () => {
    const { actor, campaign } = await createDraft();
    await forceStatus(campaign.id, "sending");
    const res = await (
      await svc()
    ).updateCampaign(actor, campaign.id, { subject: "Changed" });
    expect(res).toMatchObject({ ok: false, code: "conflict" });
    const after = await (await svc()).getCampaign(actor.teamId, campaign.id);
    expect(after!.subject).toBe("Hello");
  });

  it("refuses to edit a campaign that has sent", async () => {
    const { actor, campaign } = await createDraft();
    await forceStatus(campaign.id, "sent");
    const res = await (
      await svc()
    ).updateCampaign(actor, campaign.id, {
      blocks: [{ kind: "text", html: "Different" }],
    });
    expect(res).toMatchObject({ ok: false, code: "conflict" });
    const after = await (await svc()).getCampaign(actor.teamId, campaign.id);
    expect(after!.blocks).toEqual([{ kind: "text", html: "Hi" }]);
  });

  it("refuses to edit a cancelled campaign — some of its mail already went", async () => {
    const { actor, campaign } = await createDraft();
    await forceStatus(campaign.id, "cancelled");
    expect(
      await (await svc()).updateCampaign(actor, campaign.id, { name: "x" }),
    ).toMatchObject({ ok: false, code: "conflict" });
  });

  it("reverts a scheduled campaign to draft when it is edited", async () => {
    const { db } = await import("@/db");
    const { campaigns } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { actor, campaign } = await createDraft();
    const when = new Date(Date.now() + 3_600_000);
    await db()
      .update(campaigns)
      .set({ status: "scheduled", scheduledAt: when })
      .where(eq(campaigns.id, campaign.id));
    const res = await (
      await svc()
    ).updateCampaign(actor, campaign.id, { subject: "Reviewed" });
    if (!res.ok) throw new Error(`unreachable: ${res.error}`);
    expect(res.data.status).toBe("draft");
    // The timer goes with it: a draft carrying a scheduled_at would make the
    // sweep and the dashboard describe two different futures.
    expect(res.data.scheduledAt).toBeNull();
    const { auditLog } = await import("@/db/schema");
    const rows = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.teamId, actor.teamId));
    const upd = rows.find((r) => r.action === "campaigns.update");
    expect(upd!.diff).toMatchObject({
      status: { from: "scheduled", to: "draft" },
    });
  });

  it("does not revert a schedule when nothing actually changed", async () => {
    const { db } = await import("@/db");
    const { campaigns } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { actor, campaign } = await createDraft();
    await db()
      .update(campaigns)
      .set({
        status: "scheduled",
        scheduledAt: new Date(Date.now() + 3_600_000),
      })
      .where(eq(campaigns.id, campaign.id));
    const res = await (
      await svc()
    ).updateCampaign(actor, campaign.id, {
      name: "August news",
      blocks: [{ kind: "text", html: "Hi" }],
    });
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.status).toBe("scheduled");
    expect(res.data.scheduledAt).not.toBeNull();
  });

  it("refuses an update that points the campaign at another team's book", async () => {
    const mine = await createDraft();
    const theirs = await seedTeam();
    const res = await (
      await svc()
    ).updateCampaign(mine.actor, mine.campaign.id, { bookId: theirs.bookId });
    expect(res).toMatchObject({ ok: false, code: "validation_error" });
    const after = await (
      await svc()
    ).getCampaign(mine.actor.teamId, mine.campaign.id);
    expect(after!.bookId).toBe(mine.bookId);
  });

  it("refuses an update onto an unverified domain", async () => {
    const { db } = await import("@/db");
    const { domains } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { actor, campaign, domainId } = await createDraft();
    await db()
      .update(domains)
      .set({ status: "failed" })
      .where(eq(domains.id, domainId));
    expect(
      await (await svc()).updateCampaign(actor, campaign.id, { name: "New" }),
    ).toMatchObject({ ok: false, code: "domain_not_verified" });
  });

  /*
   * No foreign key means a campaign outlives its book. The list has to say so
   * rather than drop the row (the send happened) or throw (a deleted book is
   * not an error).
   */
  it("still lists a campaign whose book and domain were deleted", async () => {
    const { db } = await import("@/db");
    const { contactBooks, domains } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { actor, campaign, bookId, domainId } = await createDraft();
    await db().delete(contactBooks).where(eq(contactBooks.id, bookId));
    await db().delete(domains).where(eq(domains.id, domainId));
    const page = await (await svc()).listCampaignsPage(actor.teamId);
    if (!page.ok) throw new Error("unreachable");
    expect(page.data.data).toHaveLength(1);
    expect(page.data.data[0]!.id).toBe(campaign.id);
    expect(page.data.data[0]!.book).toBeNull();
    expect(page.data.data[0]!.domain).toBeNull();
    // The ids themselves are still on the row — "gone", not "never was".
    expect(page.data.data[0]!.bookId).toBe(bookId);
    const detail = await (
      await svc()
    ).getCampaignDetail(actor.teamId, campaign.id);
    expect(detail!.book).toBeNull();
    expect(detail!.domain).toBeNull();
  });

  it("renders the book and domain when they are still there", async () => {
    const { actor, campaign, domainName } = await createDraft();
    const detail = await (
      await svc()
    ).getCampaignDetail(actor.teamId, campaign.id);
    expect(detail!.book).toMatchObject({ name: "News" });
    expect(detail!.domain).toMatchObject({
      name: domainName,
      status: "verified",
    });
  });

  it("scopes reads to the team and filters by status", async () => {
    const mine = await createDraft();
    const theirs = await createDraft();
    expect(
      await (await svc()).getCampaign(mine.actor.teamId, theirs.campaign.id),
    ).toBeNull();
    expect(
      await (
        await svc()
      ).getCampaignDetail(mine.actor.teamId, theirs.campaign.id),
    ).toBeNull();
    const drafts = await (
      await svc()
    ).listCampaignsPage(mine.actor.teamId, { status: "draft" });
    if (!drafts.ok) throw new Error("unreachable");
    expect(drafts.data.data.map((c) => c.id)).toEqual([mine.campaign.id]);
    const sent = await (
      await svc()
    ).listCampaignsPage(mine.actor.teamId, { status: "sent" });
    if (!sent.ok) throw new Error("unreachable");
    expect(sent.data.data).toHaveLength(0);
  });

  it("pages newest first on an opaque cursor", async () => {
    const seed = await seedTeam();
    const ids: string[] = [];
    for (const name of ["one", "two", "three"]) {
      const c = await (
        await svc()
      ).createCampaign(seed.actor, { ...seed.draft, name });
      if (!c.ok) throw new Error("unreachable");
      ids.push(c.data.id);
    }
    const first = await (
      await svc()
    ).listCampaignsPage(seed.actor.teamId, { limit: 2 });
    if (!first.ok) throw new Error("unreachable");
    expect(first.data.data.map((c) => c.id)).toEqual([ids[2], ids[1]]);
    expect(first.data.nextCursor).toBeTruthy();
    const second = await (
      await svc()
    ).listCampaignsPage(seed.actor.teamId, {
      limit: 2,
      cursor: first.data.nextCursor!,
    });
    if (!second.ok) throw new Error("unreachable");
    expect(second.data.data.map((c) => c.id)).toEqual([ids[0]]);
    expect(second.data.nextCursor).toBeNull();
    expect(
      await (
        await svc()
      ).listCampaignsPage(seed.actor.teamId, { cursor: "not-a-cursor" }),
    ).toMatchObject({ ok: false });
  });

  it("refuses to delete a campaign that is sending", async () => {
    const { actor, campaign } = await createDraft();
    await forceStatus(campaign.id, "sending");
    expect(
      await (await svc()).deleteCampaign(actor, campaign.id),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(
      await (await svc()).getCampaign(actor.teamId, campaign.id),
    ).toBeTruthy();
  });

  /*
   * Deleting a sent campaign is "stop listing it", not "erase the send":
   * `campaign_recipients` is working state and cascades, but the `emails`
   * rows carry no constraint and stay, keeping the id of the campaign that
   * produced them. See the comment on `deleteCampaign`.
   */
  it("deletes a sent campaign, keeping its mail-log rows and dropping its recipients", async () => {
    const { db } = await import("@/db");
    const { campaignRecipients, contacts, emails } =
      await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { actor, campaign, bookId, from } = await createDraft();
    const suffix = randomBytes(4).toString("hex");
    await db()
      .insert(contacts)
      .values({
        id: `ct_${suffix}`,
        bookId,
        teamId: actor.teamId,
        email: `reader-${suffix}@b.io`,
      });
    await db()
      .insert(emails)
      .values({
        id: `em_${suffix}`,
        teamId: actor.teamId,
        from,
        fromEmail: from,
        to: [`reader-${suffix}@b.io`],
        subject: "Hello",
        source: "campaign",
        campaignId: campaign.id,
        contactId: `ct_${suffix}`,
        status: "sent",
      });
    await db()
      .insert(campaignRecipients)
      .values({
        campaignId: campaign.id,
        contactId: `ct_${suffix}`,
        emailId: `em_${suffix}`,
      });
    await forceStatus(campaign.id, "sent");

    expect(
      await (await svc()).deleteCampaign(actor, campaign.id),
    ).toMatchObject({ ok: true });
    expect(
      await (await svc()).getCampaign(actor.teamId, campaign.id),
    ).toBeNull();
    // Working state cascaded away.
    expect(
      await db()
        .select()
        .from(campaignRecipients)
        .where(eq(campaignRecipients.campaignId, campaign.id)),
    ).toHaveLength(0);
    // History did not: the row is still in the mail log, still naming the
    // campaign that produced it.
    const log = await db()
      .select()
      .from(emails)
      .where(eq(emails.campaignId, campaign.id));
    expect(log).toHaveLength(1);
    expect(log[0]!.campaignId).toBe(campaign.id);

    const { auditLog } = await import("@/db/schema");
    const audits = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.teamId, actor.teamId));
    const del = audits.find((r) => r.action === "campaigns.delete");
    expect(del!.targetId).toBe(campaign.id);
    expect(del!.diff).toMatchObject({ status: { from: "sent" } });
  });

  it("refuses invalid input without touching the table", async () => {
    const seed = await seedTeam();
    expect(
      await (
        await svc()
      ).createCampaign(seed.actor, { ...seed.draft, blocks: [] }),
    ).toMatchObject({ ok: false });
    expect(
      await (
        await svc()
      ).createCampaign(seed.actor, {
        ...seed.draft,
        blocks: [{ kind: "button", label: "Go", url: "javascript:alert(1)" }],
      }),
    ).toMatchObject({ ok: false });
    const page = await (await svc()).listCampaignsPage(seed.actor.teamId);
    if (!page.ok) throw new Error("unreachable");
    expect(page.data.data).toHaveLength(0);
  });

  it("publicCampaign drops the tenancy and the rendered artefacts", async () => {
    const { campaign } = await createDraft();
    const pub = (await svc()).publicCampaign(campaign) as Record<
      string,
      unknown
    >;
    expect(Object.keys(pub).sort()).toEqual(
      [
        "blocks",
        "bookId",
        "counts",
        "createdAt",
        "domainId",
        "from",
        "id",
        "name",
        "replyTo",
        "scheduledAt",
        "sentAt",
        "status",
        "subject",
        "updatedAt",
      ].sort(),
    );
  });
});
