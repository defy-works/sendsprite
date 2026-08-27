import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { connectTeamAws, seedTeamWithKey } from "./helpers";

/**
 * The fan-out is the most consequential code in the campaigns phase: get it
 * wrong one way and a contact is mailed twice, the other way and they are
 * never mailed at all. Neither is recoverable after the fact, so the tests
 * that matter here are the ones that run the same work twice and count what
 * came out — not the ones that check a happy path.
 */

const APP_URL = "https://mail.example.test";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  process.env.APP_URL = APP_URL;
  process.env.APP_SECRET = "f".repeat(48);
  pg = await startPg();
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
});
afterAll(async () => {
  await pg.stop();
});

const fanout = () => import("@/services/campaigns/fanout");

/** Collects what was enqueued instead of touching pg-boss. */
function recorder() {
  const jobs: { queue: string; data: object }[] = [];
  return {
    jobs,
    emailIds: () =>
      jobs
        .filter((j) => j.queue === "email.send")
        .map((j) => (j.data as { emailId: string }).emailId),
    enqueue: async (queue: string, data: object) => {
      jobs.push({ queue, data });
    },
  };
}

const BLOCKS = [
  { kind: "text", html: 'Hi <a href="https://example.test/x">here</a>' },
  { kind: "button", label: "Go", url: "https://example.test/go" },
];

interface SeedOpts {
  /** One entry per contact. `email` overrides the generated address. */
  contacts?: {
    email?: string;
    subscribed?: boolean;
    firstName?: string;
    lastName?: string;
    properties?: Record<string, string>;
  }[];
  status?: string;
  blocks?: unknown;
  subject?: string;
  mergeDefaults?: Record<string, string>;
  /** Linked layouts: seeded as team_layouts and linked to the campaign. */
  headerLayout?: unknown;
  footerLayout?: unknown;
  /** Pre-render, as `campaign.start-sweep` does before the first chunk. */
  render?: boolean;
}

/**
 * A team with a verified domain, a book of contacts and one `sending`
 * campaign, written straight to the tables.
 *
 * Contact ids are `ct_<suffix><nn>` so lexicographic order — which is the
 * order `selectEligible` walks — is the seed order, and a cursor assertion can
 * name the row it expects rather than observe it.
 */
async function seed({
  contacts: want = [{}, {}, {}],
  status = "sending",
  blocks = BLOCKS,
  subject = "Hello",
  mergeDefaults,
  headerLayout,
  footerLayout,
  render = true,
}: SeedOpts = {}) {
  const { db } = await import("@/db");
  const { campaigns, contactBooks, contacts, domains } =
    await import("@/db/schema");
  const { renderBlocks } = await import("@sendsprite/shared");
  const { team, actor } = await seedTeamWithKey();
  const suffix = randomBytes(4).toString("hex");
  const domainName = `${suffix}.example.test`;
  const domainId = `dom_${suffix}`;
  const bookId = `cb_${suffix}`;
  const campaignId = `cmp_${suffix}`;
  await db()
    .insert(domains)
    .values({
      id: domainId,
      teamId: team.id,
      name: domainName,
      region: "eu-west-1",
      dnsMode: "manual",
      status: "verified",
      mailFromDomain: `bounce.${domainName}`,
    });
  await db()
    .insert(contactBooks)
    .values({ id: bookId, teamId: team.id, name: "News" });
  const { teamLayouts } = await import("@/db/schema");
  const linkLayout = async (blocks: unknown, tag: string) => {
    if (!blocks) return null;
    const id = `lay_${suffix}${tag}`;
    await db()
      .insert(teamLayouts)
      .values({
        id,
        teamId: team.id,
        name: `${tag}-${suffix}`,
        blocks: blocks as never,
      });
    return id;
  };
  const headerLayoutId = await linkLayout(headerLayout, "h");
  const footerLayoutId = await linkLayout(footerLayout, "f");
  const ids = want.map((_, i) => `ct_${suffix}${String(i).padStart(2, "0")}`);
  await db()
    .insert(contacts)
    .values(
      want.map((c, i) => ({
        id: ids[i]!,
        bookId,
        teamId: team.id,
        email: c.email ?? `r${i}@rcpt.test`,
        subscribed: c.subscribed ?? true,
        firstName: c.firstName ?? null,
        lastName: c.lastName ?? null,
        ...(c.properties ? { properties: c.properties } : {}),
      })),
    );
  // Only a `text`/`button` list renders; a deliberately invalid one is stored
  // raw so `renderBlocks` has something to throw on.
  let rendered: { html: string; text: string } | null = null;
  if (render) {
    try {
      rendered = renderBlocks(blocks as never);
    } catch {
      rendered = null;
    }
  }
  await db()
    .insert(campaigns)
    .values({
      id: campaignId,
      teamId: team.id,
      bookId,
      domainId,
      name: "August news",
      subject,
      from: `news@${domainName}`,
      blocks: blocks as never,
      mergeDefaults: mergeDefaults ?? null,
      headerLayoutId,
      footerLayoutId,
      html: rendered?.html ?? null,
      text: rendered?.text ?? null,
      status: status as "sending",
      startedAt: new Date(),
    });
  return { db, team, actor, bookId, domainId, campaignId, ids, suffix };
}

const emailRows = async (campaignId: string) => {
  const { db } = await import("@/db");
  const { emails } = await import("@/db/schema");
  const { asc, eq } = await import("drizzle-orm");
  return db()
    .select()
    .from(emails)
    .where(eq(emails.campaignId, campaignId))
    .orderBy(asc(emails.contactId));
};

const emailCount = async (campaignId: string) => {
  const { db } = await import("@/db");
  const { emails } = await import("@/db/schema");
  const { eq, sql } = await import("drizzle-orm");
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(emails)
    .where(eq(emails.campaignId, campaignId));
  return row!.n;
};

const campaignRow = async (campaignId: string) => {
  const { db } = await import("@/db");
  const { campaigns } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await db()
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  return row!;
};

const recipientRows = async (campaignId: string) => {
  const { db } = await import("@/db");
  const { campaignRecipients } = await import("@/db/schema");
  const { asc, eq } = await import("drizzle-orm");
  return db()
    .select()
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId))
    .orderBy(asc(campaignRecipients.contactId));
};

/**
 * A row's body with the three things that are *meant* to differ per recipient
 * masked: the unsubscribe token, the email id in the tracking URLs, and the
 * click signature derived from that id. Whatever survives must be the same
 * bytes for every recipient of one campaign.
 */
const normalise = (r: { id: string; html: string | null }) =>
  (r.html ?? "")
    .replaceAll(r.id, "EMAIL_ID")
    .replace(/\/unsubscribe\/[A-Za-z0-9_-]+/g, "/unsubscribe/TOKEN")
    .replace(/&s=[A-Za-z0-9_-]+/g, "&s=SIG");

/** Sets (or clears) the team's monthly cap, as an operator or a plan would. */
async function setMonthlyCap(teamId: string, monthly: number | null) {
  const { db } = await import("@/db");
  const { teamSettings } = await import("@/db/schema");
  await db()
    .insert(teamSettings)
    .values({ teamId, monthlyLimit: monthly })
    .onConflictDoUpdate({
      target: teamSettings.teamId,
      set: { monthlyLimit: monthly, updatedAt: new Date() },
    });
}

/** Contacts appended to a book after the cursor has passed the seeded ones. */
async function addContacts(
  teamId: string,
  bookId: string,
  suffix: string,
  n: number,
) {
  const { db } = await import("@/db");
  const { contacts } = await import("@/db/schema");
  const ids = Array.from({ length: n }, (_, i) => `ct_${suffix}9${i}`);
  await db()
    .insert(contacts)
    .values(
      ids.map((id, i) => ({
        id,
        bookId,
        teamId,
        email: `late${i}@rcpt.test`,
        subscribed: true,
      })),
    );
  return ids;
}

const pauseAudits = async (campaignId: string) => {
  const { db } = await import("@/db");
  const { auditLog } = await import("@/db/schema");
  const { and, eq } = await import("drizzle-orm");
  return db()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetId, campaignId),
        eq(auditLog.action, "campaigns.paused"),
      ),
    );
};

/** Reset the cursor, which is exactly what a lost/rolled-back tick looks like. */
async function rewindCursor(campaignId: string) {
  const { db } = await import("@/db");
  const { campaigns } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  await db()
    .update(campaigns)
    .set({ fanoutCursor: null })
    .where(eq(campaigns.id, campaignId));
}

/** What `deleteBook` used to do unconditionally: the contacts cascade with it. */
async function deleteBookRow(bookId: string) {
  const { db } = await import("@/db");
  const { contactBooks } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  await db().delete(contactBooks).where(eq(contactBooks.id, bookId));
}

/** The verbatim refusal a vanished book pauses with. */
const BOOK_GONE =
  "The contact book this campaign sends to no longer exists, so the rest of its audience cannot be reached. Cancel the campaign, or restore the book to let it finish.";

describe("campaign fan-out", () => {
  it("materialises one chunk and advances the cursor", async () => {
    const { campaignId, ids } = await seed();
    const q = recorder();
    const res = await (await fanout()).fanoutChunk(campaignId, q);

    expect(res).toEqual({
      materialised: 3,
      skipped: 0,
      done: false,
      completed: false,
    });
    const rows = await emailRows(campaignId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.contactId)).toEqual(ids);
    expect(rows.map((r) => r.status)).toEqual(["queued", "queued", "queued"]);
    expect(rows.map((r) => r.source)).toEqual([
      "campaign",
      "campaign",
      "campaign",
    ]);
    expect(rows.map((r) => r.to)).toEqual([
      ["r0@rcpt.test"],
      ["r1@rcpt.test"],
      ["r2@rcpt.test"],
    ]);
    // Every recipient row points at the email it produced.
    const recips = await recipientRows(campaignId);
    expect(recips.map((r) => r.status)).toEqual(["queued", "queued", "queued"]);
    expect(recips.map((r) => r.emailId).sort()).toEqual(
      rows.map((r) => r.id).sort(),
    );
    // The cursor stops at the last contact this chunk actually processed —
    // never past it, which is what makes a crash resume rather than skip.
    expect((await campaignRow(campaignId)).fanoutCursor).toBe(ids[2]);
    expect(q.emailIds().sort()).toEqual(rows.map((r) => r.id).sort());
    // A `queued` timeline event per row, exactly as an API send writes.
    const { db } = await import("@/db");
    const { emailEvents } = await import("@/db/schema");
    const { inArray } = await import("drizzle-orm");
    const evs = await db()
      .select()
      .from(emailEvents)
      .where(
        inArray(
          emailEvents.emailId,
          rows.map((r) => r.id),
        ),
      );
    expect(evs.map((e) => e.type)).toEqual(["queued", "queued", "queued"]);
  });

  /*
   * The double-send guard, stated the way it is dangerous: run the same chunk
   * twice with no state reset at all, then count the emails. The primary key
   * on `(campaign_id, contact_id)` is what has to hold here — not the cursor,
   * which is only an optimisation.
   */
  it("running the same chunk twice sends nothing twice", async () => {
    const { campaignId } = await seed();
    const q = recorder();
    await (await fanout()).fanoutChunk(campaignId, q);
    await (await fanout()).fanoutChunk(campaignId, q);

    expect(await emailCount(campaignId)).toBe(3);
  });

  /*
   * The same guard with the cursor taken away — a rolled-back tick, a restored
   * dump, a second worker that read the cursor before the first committed. The
   * cursor cannot help here, so if anything comes out twice the primary key is
   * not doing its job.
   */
  it("does not enqueue a send for a row it did not insert", async () => {
    const { campaignId } = await seed();
    const first = recorder();
    await (await fanout()).fanoutChunk(campaignId, first);
    expect(first.emailIds()).toHaveLength(3);

    await rewindCursor(campaignId);
    const second = recorder();
    const res = await (await fanout()).fanoutChunk(campaignId, second);

    expect(res.materialised).toBe(0);
    expect(second.emailIds()).toEqual([]);
    expect(await emailCount(campaignId)).toBe(3);
    expect((await recipientRows(campaignId)).length).toBe(3);
  });

  it("finishes: the last chunk marks the campaign sent", async () => {
    const { campaignId } = await seed();
    const q = recorder();
    const first = await (await fanout()).fanoutChunk(campaignId, q);
    expect(first.done).toBe(false);
    expect((await campaignRow(campaignId)).status).toBe("sending");

    const last = await (await fanout()).fanoutChunk(campaignId, q);
    expect(last).toEqual({
      materialised: 0,
      skipped: 0,
      done: true,
      completed: true,
    });
    const row = await campaignRow(campaignId);
    expect(row.status).toBe("sent");
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(await emailCount(campaignId)).toBe(3);

    // `completed` is the "this call finished it" edge, not a level: a further
    // tick must not fire the once-only work (the `campaign.sent` webhook, the
    // count refresh) a second time.
    const again = await (await fanout()).fanoutChunk(campaignId, q);
    expect(again).toEqual({
      materialised: 0,
      skipped: 0,
      done: true,
      completed: false,
    });
  });

  /*
   * A short chunk must NOT finish the campaign: a contact added mid-send sorts
   * after the cursor, and only an empty select proves the book is walked out.
   */
  it("resumes from the cursor and picks up a contact added mid-send", async () => {
    const { campaignId, ids, bookId, team, suffix } = await seed();
    const q = recorder();
    await (await fanout()).fanoutChunk(campaignId, q);
    expect((await campaignRow(campaignId)).status).toBe("sending");

    const { db } = await import("@/db");
    const { contacts } = await import("@/db/schema");
    const lateId = `ct_${suffix}99`;
    await db().insert(contacts).values({
      id: lateId,
      bookId,
      teamId: team.id,
      email: "late@rcpt.test",
      subscribed: true,
    });

    const res = await (await fanout()).fanoutChunk(campaignId, q);
    expect(res.materialised).toBe(1);
    const rows = await emailRows(campaignId);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.contactId)).toEqual([...ids, lateId]);
    expect((await campaignRow(campaignId)).fanoutCursor).toBe(lateId);
  });

  it("substitutes a different unsubscribe link per recipient", async () => {
    const { campaignId, ids } = await seed();
    const q = recorder();
    await (await fanout()).fanoutChunk(campaignId, q);
    const rows = await emailRows(campaignId);

    const { verifyUnsubscribeToken } = await import("@sendsprite/shared/node");
    const tokens = rows.map((r) => {
      const m = /\/unsubscribe\/([A-Za-z0-9_-]+)/.exec(r.html ?? "");
      expect(m, `no unsubscribe link in ${r.id}`).not.toBeNull();
      return m![1]!;
    });
    expect(new Set(tokens).size).toBe(3);
    // Each link carries *that* recipient's claims, not merely a different one.
    expect(
      tokens.map((t) => verifyUnsubscribeToken(t, process.env.APP_SECRET!)),
    ).toEqual(ids.map((id) => ({ contactId: id, campaignId })));
    // And the plain-text alternative carries the same link, not the marker.
    const { UNSUBSCRIBE_MARKER } = await import("@sendsprite/shared");
    for (const [i, r] of rows.entries()) {
      expect(r.text).toContain(`Unsubscribe: ${APP_URL}/unsubscribe/`);
      expect(r.text).toContain(tokens[i]!);
      expect(r.text).not.toContain(UNSUBSCRIBE_MARKER);
      expect(r.html).not.toContain(UNSUBSCRIBE_MARKER);
    }
  });

  /*
   * Without this pair Gmail and Outlook show no native unsubscribe button and
   * the recipient's only exit is the spam button, which costs far more
   * reputation. The fan-out writes `emails` rows directly, so `SendEmailInput`
   * never validates these values — the header-safety rules are re-asserted
   * here because this is the only place they are checked.
   *
   * **The header and the body point at two different routes, on purpose.**
   * RFC 8058 requires the URI in `List-Unsubscribe` to accept a POST, and an
   * App Router segment holding a `page.tsx` cannot also export one — so the
   * header names `/api/unsubscribe/:token` while the footer a human clicks
   * names the page at `/unsubscribe/:token`. Pointing the header at the page
   * answers 405 to Gmail's native button: one-click silently broken, and
   * invisible to any test that only asserted the two links were equal. What
   * must be identical is the *token*, which is the recipient's identity.
   */
  it("puts List-Unsubscribe (the API route) and List-Unsubscribe-Post on every row", async () => {
    const { campaignId } = await seed();
    const q = recorder();
    await (await fanout()).fanoutChunk(campaignId, q);
    const rows = await emailRows(campaignId);
    const { NO_CONTROL_CHARS } = await import("@sendsprite/shared");
    const HEADER_NAME = /^[A-Za-z0-9-]{1,80}$/;

    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.headers["List-Unsubscribe-Post"]).toBe(
        "List-Unsubscribe=One-Click",
      );
      // The header is the POST-able API route...
      const header = /^<(.+)>$/.exec(r.headers["List-Unsubscribe"]!)![1]!;
      expect(header).toMatch(
        new RegExp(`^${APP_URL}/api/unsubscribe/[A-Za-z0-9_-]+$`),
      );
      // ...the body is the human-facing page, and it is *not* the same URL.
      // Anchored on APP_URL so `/api/unsubscribe/` cannot satisfy it.
      const inBody = new RegExp(`${APP_URL}/unsubscribe/[A-Za-z0-9_-]+`).exec(
        r.html ?? "",
      )![0];
      expect(inBody).not.toBe(header);
      expect(header).toContain(`${APP_URL}/api/unsubscribe/`);
      // Same recipient, so the same token on both.
      expect(header.split("/").at(-1)).toBe(inBody.split("/").at(-1));
      for (const [name, value] of Object.entries(r.headers)) {
        expect(name).toMatch(HEADER_NAME);
        expect(value).toMatch(NO_CONTROL_CHARS);
      }
    }
  });

  it("records a skipped recipient with a reason instead of an email row", async () => {
    // `contacts.email` has a check constraint on its *shape*, not on its
    // validity, so an address the send path cannot parse can reach the book.
    const { campaignId, ids } = await seed({
      contacts: [{}, { email: "not-an-address" }, {}],
    });
    const q = recorder();
    const res = await (await fanout()).fanoutChunk(campaignId, q);

    expect(res.materialised).toBe(2);
    expect(res.skipped).toBe(1);
    const recips = await recipientRows(campaignId);
    expect(recips.map((r) => [r.contactId, r.status, r.skipReason])).toEqual([
      [ids[0], "queued", null],
      [ids[1], "skipped", "invalid"],
      [ids[2], "queued", null],
    ]);
    // No email row, and no send job, for the skipped one.
    const rows = await emailRows(campaignId);
    expect(rows.map((r) => r.contactId)).toEqual([ids[0], ids[2]]);
    expect(q.emailIds()).toHaveLength(2);
    // And it is not reconsidered on the next tick, which is what would stop
    // the campaign ever finishing.
    const next = await (await fanout()).fanoutChunk(campaignId, q);
    expect(next).toMatchObject({ done: true, completed: true });
  });

  /*
   * `renderBlocks` runs once per campaign, and its output is what every
   * recipient gets. Anything else means the first and the last recipient of
   * one campaign receive different mail.
   */
  it("renders once — every recipient gets byte-identical body HTML apart from the unsubscribe link", async () => {
    const { campaignId } = await seed();
    const q = recorder();
    await (await fanout()).fanoutChunk(campaignId, q);
    const rows = await emailRows(campaignId);

    const bodies = new Set(rows.map(normalise));
    expect(bodies.size).toBe(1);
    // The bodies are the campaign's stored render, not a fresh one.
    const stored = await campaignRow(campaignId);
    expect(stored.html).toContain("Hi <a");
    expect([...bodies][0]).toContain("Go");
  });

  /*
   * The same property across chunks, which is the version that actually bites:
   * editing `blocks` under a half-sent campaign must not change what the
   * remaining recipients receive.
   */
  it("ignores a block edit made mid-send", async () => {
    const { campaignId, db } = await seed({ contacts: [{}, {}] });
    const q = recorder();
    await (await fanout()).fanoutChunk(campaignId, q);
    const before = (await emailRows(campaignId))[0]!;

    const { campaigns } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db()
      .update(campaigns)
      .set({ blocks: [{ kind: "text", html: "TOTALLY DIFFERENT" }] as never })
      .where(eq(campaigns.id, campaignId));

    const { contacts } = await import("@/db/schema");
    const seedRow = await campaignRow(campaignId);
    await db()
      .insert(contacts)
      .values({
        id: `${campaignId.replace("cmp_", "ct_")}99`,
        bookId: seedRow.bookId,
        teamId: seedRow.teamId,
        email: "late@rcpt.test",
        subscribed: true,
      });
    await (await fanout()).fanoutChunk(campaignId, q);

    const after = (await emailRows(campaignId)).at(-1)!;
    expect(after.html).not.toContain("TOTALLY DIFFERENT");
    expect(normalise(after)).toBe(normalise(before));
  });

  it("renders and stores the body when the start sweep has not", async () => {
    const { campaignId } = await seed({ render: false });
    const q = recorder();
    const res = await (await fanout()).fanoutChunk(campaignId, q);

    expect(res.materialised).toBe(3);
    const stored = await campaignRow(campaignId);
    expect(stored.html).toContain("Hi <a");
    expect(stored.text).toContain("Hi");
  });

  /*
   * A campaign that is `sending` and whose stored blocks no longer validate
   * cannot be fixed by retrying. Left `sending` it would throw on every sweep
   * tick, for ever — a stuck campaign logging an exception a minute is its own
   * incident. It is stopped once, loudly, with the reason on the audit trail.
   */
  it("stops a campaign whose stored blocks no longer render", async () => {
    const { campaignId, team } = await seed({
      blocks: [{ kind: "text", html: 'go <img src="x" onerror="alert(1)">' }],
      render: false,
    });
    const q = recorder();
    const res = await (await fanout()).fanoutChunk(campaignId, q);

    expect(res).toEqual({
      materialised: 0,
      skipped: 0,
      done: true,
      completed: false,
    });
    expect((await campaignRow(campaignId)).status).toBe("cancelled");
    expect(await emailCount(campaignId)).toBe(0);
    expect(q.jobs).toEqual([]);

    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const audits = await db()
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.teamId, team.id), eq(auditLog.targetId, campaignId)),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("campaigns.stopped");
    expect(audits[0]!.diff).toMatchObject({ reason: { to: "invalid_blocks" } });

    // And the next tick does nothing at all rather than throwing again.
    expect(await (await fanout()).fanoutChunk(campaignId, q)).toMatchObject({
      done: true,
    });
  });

  it("a cancel between ticks stops the fan-out and leaves the cursor alone", async () => {
    const { campaignId, db } = await seed();
    const { campaigns } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db()
      .update(campaigns)
      .set({ status: "cancelled" })
      .where(eq(campaigns.id, campaignId));

    const q = recorder();
    expect(await (await fanout()).fanoutChunk(campaignId, q)).toEqual({
      materialised: 0,
      skipped: 0,
      done: true,
      completed: false,
    });
    expect(await emailCount(campaignId)).toBe(0);
    expect(await recipientRows(campaignId)).toEqual([]);
    expect((await campaignRow(campaignId)).fanoutCursor).toBeNull();
    expect(q.jobs).toEqual([]);
  });

  it("does nothing for a campaign that has been deleted", async () => {
    const q = recorder();
    expect(await (await fanout()).fanoutChunk("cmp_gone", q)).toEqual({
      materialised: 0,
      skipped: 0,
      done: true,
      completed: false,
    });
    expect(q.jobs).toEqual([]);
  });

  /*
   * Selection already excludes them (consent ∩ deliverability), and the fan-out
   * must not quietly widen that: an unsubscribed contact gets no row of any
   * kind here, and no email.
   */
  it("never materialises an unsubscribed contact", async () => {
    const { campaignId, ids } = await seed({
      contacts: [{}, { subscribed: false }, {}],
    });
    const q = recorder();
    const res = await (await fanout()).fanoutChunk(campaignId, q);

    expect(res.materialised).toBe(2);
    const rows = await emailRows(campaignId);
    expect(rows.map((r) => r.contactId)).toEqual([ids[0], ids[2]]);
    expect((await recipientRows(campaignId)).map((r) => r.contactId)).toEqual([
      ids[0],
      ids[2],
    ]);
  });

  /*
   * `String.replace` with a string replaces only the first occurrence, and a
   * `$` in a *replacement* string is a substitution pattern in both `replace`
   * and `replaceAll`. The marker appears once in a rendered body today, so a
   * `replace` would pass every other test in this file; assert on the property
   * rather than on today's block list.
   */
  it("substitutes every marker, and never treats the link as a $-pattern", async () => {
    const { UNSUBSCRIBE_MARKER } = await import("@sendsprite/shared");
    const { resetEnvCache } = await import("@/env.schema");
    // `$&` inside the *replacement* is what makes this dangerous: with a
    // string replacement it expands to the matched marker, putting a raw
    // control character into the body of exactly the recipients whose link
    // happens to contain one. A base64url token never will — but `APP_URL` is
    // part of the same replacement, and it is operator-supplied.
    process.env.APP_URL = "https://mail.example.test/p$&q";
    resetEnvCache();
    try {
      const { campaignId, db } = await seed({ contacts: [{}] });
      const { campaigns } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const [row] = await db()
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, campaignId));
      // Three markers, because `String.replace` with a string would take only
      // the first and a rendered body carries exactly one today — the bug
      // would pass every other test in this file.
      await db()
        .update(campaigns)
        .set({
          html: `${row!.html}<p>${UNSUBSCRIBE_MARKER}</p><p>${UNSUBSCRIBE_MARKER}</p>`,
          text: `${row!.text}\n${UNSUBSCRIBE_MARKER}`,
        })
        .where(eq(campaigns.id, campaignId));

      const q = recorder();
      await (await fanout()).fanoutChunk(campaignId, q);
      const [email] = await emailRows(campaignId);

      expect(email!.html).not.toContain(UNSUBSCRIBE_MARKER);
      expect(email!.text).not.toContain(UNSUBSCRIBE_MARKER);
      expect(email!.html!.match(/\/unsubscribe\//g)).toHaveLength(3);
      expect(email!.text!.match(/Unsubscribe: /g)).toHaveLength(2);
      // The `$&` survived as itself in every link, in both bodies.
      expect(email!.html!.match(/p\$&amp;q\/unsubscribe\//g)).toHaveLength(3);
      expect(email!.text!.match(/p\$&q\/unsubscribe\//g)).toHaveLength(2);
    } finally {
      process.env.APP_URL = APP_URL;
      resetEnvCache();
    }
  });

  /*
   * `checkTeamCaps` and `checkInstanceQuota` are called from `createEmail`,
   * which the fan-out never calls — so a campaign was counted by the billing
   * meter and by no cap at all, and a Free-plan team could fan out 50 000
   * recipients. The interesting case is not the refusal, it is the refusal
   * arriving *mid-campaign*: the earlier chunks are already in inboxes.
   */
  it("pauses mid-campaign when the team's monthly cap is reached", async () => {
    const { campaignId, team, bookId, suffix } = await seed();
    await setMonthlyCap(team.id, 5);
    const q = recorder();

    // 3 of the 5 spent by the first chunk.
    const first = await (await fanout()).fanoutChunk(campaignId, q);
    expect(first.materialised).toBe(3);
    await addContacts(team.id, bookId, suffix, 3);

    // The next chunk wants 3 more and only 2 remain: refused whole.
    const res = await (await fanout()).fanoutChunk(campaignId, q);
    expect(res).toEqual({
      materialised: 0,
      skipped: 0,
      done: false,
      completed: false,
      paused: {
        code: "monthly_quota_exceeded",
        message: "Monthly limit of 5 emails reached.",
      },
    });
    expect(await emailCount(campaignId)).toBe(3);
    expect(q.emailIds()).toHaveLength(3);
    // Paused, not cancelled: a cap stops being true on its own, and a
    // `cancelled` campaign cannot be restarted — the customer's only route
    // back would be a new campaign, which would re-mail everyone already sent.
    const row = await campaignRow(campaignId);
    expect(row.status).toBe("sending");
    expect(row.sentAt).toBeNull();
    // The cursor has not moved past work that was never done.
    expect(row.fanoutCursor).toBe(`ct_${suffix}02`);
    // And it is visible, naming the cap that refused and why.
    const audits = await pauseAudits(campaignId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.diff).toMatchObject({
      reason: { to: "monthly_quota_exceeded" },
      detail: { to: "Monthly limit of 5 emails reached." },
    });
  });

  /*
   * The property that makes "pause" the right choice rather than "cancel":
   * lifting the cap resumes the same campaign from the recipient it stopped
   * at, and nobody is mailed twice on the way through.
   */
  it("resumes from where the cap paused it, once the cap is lifted", async () => {
    const { campaignId, team, bookId, suffix } = await seed();
    await setMonthlyCap(team.id, 5);
    const q = recorder();
    await (await fanout()).fanoutChunk(campaignId, q);
    const late = await addContacts(team.id, bookId, suffix, 3);
    const paused = await (await fanout()).fanoutChunk(campaignId, q);
    expect(paused.paused).toMatchObject({ code: "monthly_quota_exceeded" });

    await setMonthlyCap(team.id, 100);
    const resumed = await (await fanout()).fanoutChunk(campaignId, q);

    expect(resumed).toMatchObject({ materialised: 3, done: false });
    const rows = await emailRows(campaignId);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.contactId)).toEqual([
      `ct_${suffix}00`,
      `ct_${suffix}01`,
      `ct_${suffix}02`,
      ...late,
    ]);
    // Exactly one email per contact, across the pause.
    expect(new Set(rows.map((r) => r.contactId)).size).toBe(6);
    expect(await (await fanout()).fanoutChunk(campaignId, q)).toMatchObject({
      done: true,
      completed: true,
    });
    expect((await campaignRow(campaignId)).status).toBe("sent");
  });

  /*
   * A paused campaign is asked again on every sweep tick for as long as the
   * cap holds — which can be the rest of a billing month. One audit row per
   * cap, not one per minute, or the log has no signal left in it.
   */
  it("records the pause once however many ticks it stays capped", async () => {
    const { campaignId, team } = await seed();
    await setMonthlyCap(team.id, 1);
    const q = recorder();

    for (let i = 0; i < 3; i++) {
      const res = await (await fanout()).fanoutChunk(campaignId, q);
      expect(res.paused).toMatchObject({ code: "monthly_quota_exceeded" });
    }

    expect(await pauseAudits(campaignId)).toHaveLength(1);
    expect(await emailCount(campaignId)).toBe(0);
    expect(await recipientRows(campaignId)).toEqual([]);
    expect(q.jobs).toEqual([]);
    expect((await campaignRow(campaignId)).status).toBe("sending");
  });

  /*
   * The self-hoster's version of the same hole: `ses_daily_quota` is an
   * instance setting somebody chose deliberately, and a campaign ignoring it
   * is a broken setting rather than a missed invoice.
   */
  it("pauses on the instance SES quota as well as the team cap", async () => {
    const { campaignId, team } = await seed();
    const { db } = await import("@/db");
    const { emails } = await import("@/db/schema");
    const { newId } = await import("@sendsprite/shared");
    // One send already accepted by SES inside the trailing 24 h.
    await db()
      .insert(emails)
      .values({
        id: newId("em"),
        teamId: team.id,
        from: "a@x.io",
        fromEmail: "a@x.io",
        to: ["prior@rcpt.test"],
        subject: "prior",
        text: "t",
        status: "sent",
        sentAt: new Date(),
      });
    await connectTeamAws(team.id, { sesDailyQuota: 2 });
    try {
      const q = recorder();
      const res = await (await fanout()).fanoutChunk(campaignId, q);

      expect(res.paused).toMatchObject({ code: "daily_quota_exceeded" });
      expect(await emailCount(campaignId)).toBe(0);
      expect((await campaignRow(campaignId)).status).toBe("sending");
    } finally {
      await connectTeamAws(team.id, { sesDailyQuota: null });
    }
  });

  /*
   * The fourth guard gap in this file, and the only one with no downstream
   * symptom at all. The finish condition is an empty select; `contacts.book_id`
   * cascades from `contact_books` and `campaigns.book_id` carries no foreign
   * key — so deleting a book mid-send empties the next chunk and the fan-out
   * reads that as "the book is walked out". Before the check, this test ended
   * with the campaign `sent`, a `sent_at`, and a `campaign.sent` webhook owed,
   * having mailed 3 of the 6 people it claimed.
   */
  it("pauses instead of finishing when the book is deleted mid-send", async () => {
    const { campaignId, bookId, team, suffix } = await seed();
    const q = recorder();
    const first = await (await fanout()).fanoutChunk(campaignId, q);
    expect(first.materialised).toBe(3);
    // Three more it still owes, so "walked out" would be a lie about them.
    await addContacts(team.id, bookId, suffix, 3);

    await deleteBookRow(bookId);
    const res = await (await fanout()).fanoutChunk(campaignId, q);

    expect(res).toEqual({
      materialised: 0,
      skipped: 0,
      done: false,
      completed: false,
      paused: { code: "not_found", message: BOOK_GONE },
    });
    // `completed` is the once-only edge that fires `campaign.sent`; it must
    // never have been true, and `sent_at` is the same claim in a column.
    const row = await campaignRow(campaignId);
    expect(row.status).toBe("sending");
    expect(row.sentAt).toBeNull();
    expect(await emailCount(campaignId)).toBe(3);
    const audits = await pauseAudits(campaignId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.diff).toMatchObject({
      reason: { to: "not_found" },
      detail: { to: BOOK_GONE },
    });

    // Asked again every minute for as long as nobody looks: still paused,
    // still not `sent`, and still one audit row rather than one per tick.
    for (let i = 0; i < 2; i++)
      expect(await (await fanout()).fanoutChunk(campaignId, q)).toMatchObject({
        done: false,
        completed: false,
      });
    expect(await pauseAudits(campaignId)).toHaveLength(1);
    expect((await campaignRow(campaignId)).status).toBe("sending");
  });

  /*
   * The property that makes pausing the right call rather than cancelling:
   * restoring the book leaves the campaign able to finish from its cursor,
   * where `cancelled` would be terminal and the only route on would be a
   * second campaign that re-mails everyone already sent.
   */
  it("finishes normally once a deleted book is restored", async () => {
    const { campaignId, bookId, team } = await seed();
    const q = recorder();
    await (await fanout()).fanoutChunk(campaignId, q);
    await deleteBookRow(bookId);
    expect(
      (await (await fanout()).fanoutChunk(campaignId, q)).paused,
    ).toMatchObject({ code: "not_found" });

    const { db } = await import("@/db");
    const { contactBooks } = await import("@/db/schema");
    await db()
      .insert(contactBooks)
      .values({ id: bookId, teamId: team.id, name: "News" });

    const res = await (await fanout()).fanoutChunk(campaignId, q);
    expect(res).toEqual({
      materialised: 0,
      skipped: 0,
      done: true,
      completed: true,
    });
    expect((await campaignRow(campaignId)).status).toBe("sent");
    expect(await emailCount(campaignId)).toBe(3);
  });

  /*
   * A book walked out for real is not the anomaly, and the check must not
   * make it one: an empty select with the book still there finishes on the
   * same tick it always did.
   */
  it("still finishes a campaign whose book is genuinely walked out", async () => {
    const { campaignId } = await seed();
    const q = recorder();
    await (await fanout()).fanoutChunk(campaignId, q);

    expect(await (await fanout()).fanoutChunk(campaignId, q)).toEqual({
      materialised: 0,
      skipped: 0,
      done: true,
      completed: true,
    });
    expect(await pauseAudits(campaignId)).toEqual([]);
  });

  /*
   * The same hole one moment earlier: `startCampaign` renders and flips, and
   * checked the domain but not the book — so a campaign scheduled for
   * Thursday whose audience was deleted on Wednesday flipped to `sending`,
   * selected nobody on its first chunk and reported itself `sent` to nought
   * recipients. `scheduled` is still editable, so this defers rather than
   * cancels, exactly as the domain check does.
   */
  it("does not start a scheduled campaign whose book was deleted", async () => {
    const { campaignId, bookId, team } = await seed({
      status: "scheduled",
      render: false,
    });
    await deleteBookRow(bookId);

    const res = await (await fanout()).startCampaign(campaignId);

    expect(res.started).toBe(false);
    expect(res.deferred).toMatchObject({ code: "not_found" });
    const row = await campaignRow(campaignId);
    expect(row.status).toBe("scheduled");
    // Deferred before the render, so nothing was stored on the way past.
    expect(row.html).toBeNull();
    expect(await pauseAudits(campaignId)).toHaveLength(1);

    // And it is a defer, not a stop: a book at that id again and the very
    // next tick starts it.
    const { db } = await import("@/db");
    const { contactBooks } = await import("@/db/schema");
    await db()
      .insert(contactBooks)
      .values({ id: bookId, teamId: team.id, name: "News" });
    expect((await (await fanout()).startCampaign(campaignId)).started).toBe(
      true,
    );
    expect((await campaignRow(campaignId)).status).toBe("sending");
  });
});

describe("per-recipient merge fields", () => {
  const MERGE_BLOCKS = [
    { kind: "text", html: "Hi {{ firstName }} at {{ properties.company }}" },
  ];

  it("gives each recipient their own subject and body", async () => {
    const { campaignId } = await seed({
      subject: "Hello {{ firstName }}",
      blocks: MERGE_BLOCKS,
      contacts: [
        {
          email: "ada@rcpt.test",
          firstName: "Ada",
          properties: { company: "Analytical" },
        },
        {
          email: "bo@rcpt.test",
          firstName: "Bo",
          properties: { company: "Bytes" },
        },
      ],
    });
    const rec = recorder();
    await (await fanout()).fanoutChunk(campaignId, { enqueue: rec.enqueue });
    const rows = await emailRows(campaignId);
    expect(rows).toHaveLength(2);
    const byTo = Object.fromEntries(rows.map((r) => [r.to[0], r]));
    expect(byTo["ada@rcpt.test"]!.subject).toBe("Hello Ada");
    expect(byTo["ada@rcpt.test"]!.html).toContain("Hi Ada at Analytical");
    expect(byTo["bo@rcpt.test"]!.subject).toBe("Hello Bo");
    expect(byTo["bo@rcpt.test"]!.html).toContain("Hi Bo at Bytes");
  });

  it("a missing field uses the author fallback, or empty", async () => {
    const { campaignId } = await seed({
      subject: "Hi {{ firstName }}",
      blocks: [
        { kind: "text", html: "{{ firstName }} / {{ properties.company }}" },
      ],
      mergeDefaults: { firstName: "there" },
      contacts: [{ email: "no@rcpt.test" }],
    });
    const rec = recorder();
    await (await fanout()).fanoutChunk(campaignId, { enqueue: rec.enqueue });
    const [row] = await emailRows(campaignId);
    // firstName falls back to "there"; company has no fallback → empty.
    expect(row!.subject).toBe("Hi there");
    expect(row!.html).toContain("there / ");
  });

  it("HTML-escapes a merge value in the body", async () => {
    const { campaignId } = await seed({
      subject: "x",
      blocks: [{ kind: "text", html: "{{ firstName }}" }],
      contacts: [{ email: "x@rcpt.test", firstName: '<b>"' }],
    });
    const rec = recorder();
    await (await fanout()).fanoutChunk(campaignId, { enqueue: rec.enqueue });
    const [row] = await emailRows(campaignId);
    expect(row!.html).toContain("&lt;b&gt;&quot;");
    expect(row!.html).not.toContain("<b>");
  });

  it("strips a control character a value would inject into the subject", async () => {
    const { campaignId } = await seed({
      subject: "Hi {{ firstName }}",
      blocks: [{ kind: "text", html: "x" }],
      contacts: [{ email: "inj@rcpt.test", firstName: "Ada\r\nBcc: evil@x" }],
    });
    const rec = recorder();
    await (await fanout()).fanoutChunk(campaignId, { enqueue: rec.enqueue });
    const [row] = await emailRows(campaignId);
    expect(row!.subject).toBe("Hi AdaBcc: evil@x");
    expect(row!.subject).not.toMatch(/[\r\n]/);
  });

  it("a campaign with no merge fields is unaffected (fast path)", async () => {
    const { campaignId } = await seed({
      subject: "Plain",
      contacts: [{ email: "p@rcpt.test", firstName: "Ada" }],
    });
    const rec = recorder();
    await (await fanout()).fanoutChunk(campaignId, { enqueue: rec.enqueue });
    const [row] = await emailRows(campaignId);
    expect(row!.subject).toBe("Plain");
  });
});

describe("linked header and footer layouts", () => {
  const HEADER = [{ kind: "text", html: "TOP-OF-EMAIL" }];
  const FOOTER = [{ kind: "text", html: "BOTTOM-OF-EMAIL" }];
  const BODY = [{ kind: "text", html: "THE-BODY" }];

  it("renders header, then body, then footer, then the unsubscribe marker", async () => {
    // render:false so startCampaign does the compose-and-store, which is the
    // path a real send takes.
    const { campaignId } = await seed({
      blocks: BODY,
      headerLayout: HEADER,
      footerLayout: FOOTER,
      status: "scheduled",
      render: false,
    });
    const rec = recorder();
    // startCampaign renders + stores; then a chunk materialises the rows.
    await (await fanout()).startCampaign(campaignId, {});
    await (await fanout()).fanoutChunk(campaignId, { enqueue: rec.enqueue });
    const [row] = await emailRows(campaignId);
    const html = row!.html!;
    const top = html.indexOf("TOP-OF-EMAIL");
    const body = html.indexOf("THE-BODY");
    const bottom = html.indexOf("BOTTOM-OF-EMAIL");
    const unsub = html.indexOf("Unsubscribe");
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(body);
    expect(body).toBeLessThan(bottom);
    expect(bottom).toBeLessThan(unsub);
  });

  it("resolves the layout at send, so an edit before send lands in the mail", async () => {
    const { campaignId, db, suffix } = await seed({
      blocks: BODY,
      headerLayout: [{ kind: "text", html: "OLD-HEADER" }],
      status: "scheduled",
      render: false,
    });
    // Edit the linked layout after the campaign was drafted, before it starts.
    const { teamLayouts } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db()
      .update(teamLayouts)
      .set({ blocks: [{ kind: "text", html: "NEW-HEADER" }] as never })
      .where(eq(teamLayouts.id, `lay_${suffix}h`));
    const rec = recorder();
    await (await fanout()).startCampaign(campaignId, {});
    await (await fanout()).fanoutChunk(campaignId, { enqueue: rec.enqueue });
    const [row] = await emailRows(campaignId);
    expect(row!.html).toContain("NEW-HEADER");
    expect(row!.html).not.toContain("OLD-HEADER");
  });

  it("tolerates a linked layout that was deleted: the slot is just empty", async () => {
    const { campaignId, db, suffix } = await seed({
      blocks: BODY,
      headerLayout: HEADER,
      status: "scheduled",
      render: false,
    });
    const { teamLayouts } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db()
      .delete(teamLayouts)
      .where(eq(teamLayouts.id, `lay_${suffix}h`));
    const rec = recorder();
    await (await fanout()).startCampaign(campaignId, {});
    await (await fanout()).fanoutChunk(campaignId, { enqueue: rec.enqueue });
    const [row] = await emailRows(campaignId);
    expect(row!.html).toContain("THE-BODY");
    expect(row!.html).not.toContain("TOP-OF-EMAIL");
  });
});
