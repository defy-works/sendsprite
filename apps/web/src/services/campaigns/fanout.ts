import { and, eq, inArray, sql } from "drizzle-orm";
import {
  InvalidCampaignBlockError,
  type CampaignBlock,
  UNSUBSCRIBE_MARKER,
  escapeHtml,
  newId,
  placeholderCount,
  renderBlocks,
  renderCampaignFields,
  withHeaderFooter,
  type ErrorCode,
} from "@sendsprite/shared";
import { db } from "@/db";
import {
  auditLog,
  campaignRecipients,
  campaigns,
  contactBooks,
  emailEvents,
  emails,
  teamLayouts,
  teamSettings,
  type Campaign,
  type CampaignRecipientStatus,
} from "@/db/schema";
import { loadEnv } from "@/env.schema";
import { recordAudit } from "@/lib/audit";
import { parseAddress } from "@/lib/email-address";
import { injectPixel, wrapLinks } from "@/lib/tracking";
import { Q } from "@/jobs/queues";
import type { Enqueue } from "../domains";
import { resolveSendingDomain } from "../emails";
import { checkAccountQuota, checkTeamCaps } from "../send-limits";
import { unsubscribeLinks } from "../unsubscribe";
import { selectEligible, type EligibleContact } from "./audience";

/**
 * One bounded chunk of a campaign's fan-out — the only thing in the product
 * that creates campaign `emails` rows.
 *
 * A campaign is a recipient-row generator (Decision 1): this writes ordinary
 * `emails` rows with `source: "campaign"` and lets the existing `email.send`
 * queue, SES token bucket, tracking, events, webhooks and metering do the
 * rest. Nothing here talks to SES.
 *
 * ## The four properties this file exists to hold
 *
 * 1. **Nobody is mailed twice.** The guard is the composite primary key on
 *    `campaign_recipients (campaign_id, contact_id)` and nothing else. The
 *    cursor is an optimisation; a sweep that ticks twice, a worker that
 *    overlaps another, a retried job — all of them re-select the same
 *    contacts, and all of them are turned into no-ops by that constraint.
 *    Concretely: the recipient rows are inserted **first**, with
 *    `on conflict do nothing` and `.returning()`, and an `emails` row is
 *    written only for a contact whose recipient row actually came back. A
 *    chunk run twice therefore produces exactly the emails a chunk run once
 *    produces.
 * 2. **Nobody is silently missed.** The recipient rows, the email rows and
 *    the cursor advance are one transaction, so a crash or a rollback leaves
 *    the cursor exactly where the recipient table says the work stopped.
 *    The cursor only ever moves forward over contacts that were committed in
 *    the same transaction — and only forward: `greatest(...)` below makes an
 *    out-of-order tick unable to rewind it.
 * 3. **This function never enqueues itself.** A handler on an exclusive queue
 *    that re-enqueues itself has silently stalled this codebase twice; it is
 *    a recorded, absolute rule. Continuation is `campaign.fan-out-sweep` on a
 *    cron, one chunk per tick. If this ever wants to recurse, the answer is a
 *    larger {@link CHUNK}.
 * 4. **Render once, substitute per recipient.** `renderBlocks` runs once per
 *    campaign and its output is stored on the campaign row; every recipient's
 *    body is that stored HTML with {@link UNSUBSCRIBE_MARKER} swapped for
 *    their own link. Re-rendering per recipient would let an edit to `blocks`
 *    mid-send give the first and last recipient different mail.
 *
 * 5. **A campaign is subject to the same send caps as an API send.** The
 *    guarantees a campaign was meant to inherit by reusing the ordinary send
 *    path are only inherited as far as that path is actually reused, and two
 *    of them live in `createEmail`, which this never calls: the team's
 *    daily/monthly caps and the instance's SES quota. They are checked here
 *    instead, once per chunk. A cap **pauses** the campaign rather than ending
 *    it — see {@link notePaused} for why that is not the same choice the other
 *    campaign-level refusals in this file make.
 *
 *    The third such guarantee, suppression, is not re-checked here on purpose:
 *    `selectEligible` filters it at materialisation and `sendQueuedEmail` now
 *    re-checks it per message immediately before SES, which is the only place
 *    that can catch a bounce or complaint arriving after this ran.
 *
 * 6. **The sending domain is a campaign-level fact, re-checked per chunk.**
 *    `crud.ts` checks the domain at create and update time, and
 *    `campaigns.domain_id` deliberately carries no foreign key, so between
 *    authoring and the last chunk the domain can be deleted or fall out of
 *    verification and nothing downstream notices per campaign — only per
 *    message, 38 000 times. See {@link domainRefusal}.
 *
 * 7. **An empty select is not proof that the book was walked out.** The whole
 *    finish condition is "this chunk selected nobody", and `contacts.book_id`
 *    cascades from `contact_books` while `campaigns.book_id` carries no
 *    foreign key at all — so deleting a book mid-send takes every contact
 *    with it, empties the select, and the fan-out reads that as the end of
 *    the audience. Unlike the domain and the caps this has **no downstream
 *    symptom at all**: the campaign flips to `sent`, fires `campaign.sent`,
 *    stamps a completion time, and nothing anywhere ever contradicts it. The
 *    customer is told a 50 000-recipient campaign completed when 12 000
 *    people got it. See {@link bookRefusal}.
 *
 * ## Crash windows, and what recovers each
 *
 * - Crash **before** the commit: nothing happened. The next tick re-selects
 *   the same contacts from the same cursor.
 * - Crash **between** the commit and the `email.send` enqueue: the rows exist
 *   as `queued` with no job. `email.queued-sweep` re-enqueues due `queued`
 *   rows untouched for 5 minutes, which is exactly this case.
 * - Crash **during** the enqueue loop: same, for whatever is left.
 *
 * ## Known race (recorded, not fixed here)
 *
 * `campaign_recipients.contact_id` cascades, so deleting a contact mid-send
 * removes its recipient row; re-importing that contact mints a new ULID which
 * a still-`sending` campaign can pick up and mail again. `restrict` would
 * close it at the cost of 500-ing contact deletion, which is worse. Phase 8
 * opener.
 */

/**
 * Recipients materialised per call.
 *
 * Raising this is the supported way to make a big campaign finish sooner —
 * the sweep runs once a minute and does one chunk per campaign, so 500 is
 * 30 000 recipients an hour per campaign. It is not the send rate: that is
 * governed downstream by the SES token bucket.
 */
export const CHUNK = 500;

export interface FanoutResult {
  /** Recipients this call turned into `emails` rows. */
  materialised: number;
  /** Recipients this call recorded as skipped (no email row, ever). */
  skipped: number;
  /** No further chunk is owed: finished, cancelled, or gone. */
  done: boolean;
  /**
   * This call is the one that flipped `sending` → `sent`.
   *
   * Not in the plan's `FanoutResult`; added because the flip happens here and
   * the things that must happen *once* when a campaign finishes — the
   * `campaign.sent` webhook (Task 9) and the count-cache refresh (Decision 8)
   * — live in the sweep (Task 8). Deriving "did it just finish?" from `done`
   * would fire them again on every tick that finds the campaign already
   * `sent`. Callers that do not care can ignore it.
   */
  completed: boolean;
  /**
   * Present only when a campaign-level refusal stopped this chunk: a send cap
   * ({@link capRefusal}), a sending domain that is no longer verified
   * ({@link domainRefusal}), or a contact book that no longer exists
   * ({@link bookRefusal}). The campaign is left `sending` and owes the rest of
   * its audience.
   *
   * Optional so the shape of an ordinary tick is unchanged — a caller that
   * does not care about refusals reads `materialised: 0, done: false` and
   * simply ticks again, which is the correct behaviour anyway.
   */
  paused?: { code: ErrorCode; message: string };
}

/** A campaign that owes no more chunks. */
const DONE: FanoutResult = {
  materialised: 0,
  skipped: 0,
  done: true,
  completed: false,
};

/**
 * A campaign-level refusal that stops a chunk without ending the campaign —
 * what {@link capRefusal}, {@link domainRefusal} and {@link bookRefusal}
 * return, and what {@link notePaused} audits.
 */
type Refusal = { code: ErrorCode; message: string };

/**
 * A tick that materialised nothing and left the campaign `sending`.
 *
 * Deliberately not {@link DONE}: the campaign still owes the rest of its
 * audience, so the sweep must keep asking. What makes that not a spin is that
 * every refusal is recorded once (see {@link notePaused}), never once a tick.
 */
const pausedResult = (paused: Refusal): FanoutResult => ({
  materialised: 0,
  skipped: 0,
  done: false,
  completed: false,
  paused,
});

/**
 * One recipient's materialised row, or the reason there will not be one.
 *
 * Built before the transaction so the transaction is only inserts: signing a
 * token and rewriting a body per recipient is CPU, and holding a row lock on
 * the campaign while doing it for 500 contacts would block a cancel for the
 * duration.
 */
type EmailInsert = typeof emails.$inferInsert;
type Materialised = {
  contact: EligibleContact;
  emailId: string;
  row: EmailInsert & { id: string };
};
type Skipped = {
  contact: EligibleContact;
  emailId: null;
  skipReason: string;
};
type Planned = Materialised | Skipped;

const isMaterialised = (p: Planned): p is Materialised => p.emailId !== null;

/**
 * Materialise at most {@link CHUNK} recipients for one campaign and return.
 *
 * Takes a bare `campaignId` and no `teamId`: the id comes from the sweep's own
 * `status = 'sending'` query, not from a request, so there is no caller whose
 * tenancy could be asserted. The team is read off the row and used for every
 * subsequent query — `selectEligible` is team-scoped, and so are the rows this
 * writes.
 */
export async function fanoutChunk(
  campaignId: string,
  deps: { enqueue: Enqueue; now?: Date },
): Promise<FanoutResult> {
  const now = deps.now ?? new Date();
  const [loaded] = await db()
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  // Deleted, or cancelled/finished between ticks. A cancel must stop the
  // fan-out, and it is only ever observed here and at the transaction below.
  if (!loaded || loaded.status !== "sending") return DONE;

  const campaign = await ensureRendered(loaded);
  if (!campaign) return DONE; // stopped: the body no longer renders.

  // Parsed once, not per recipient: a `from` this cannot parse makes every
  // row in the campaign unsendable, so it is a campaign-level stop rather
  // than 50 000 individually failing sends.
  const from = parseAddress(campaign.from);
  if (!from) {
    await stopCampaign(
      campaign,
      "invalid_from",
      `The from address ${campaign.from} is not a valid address.`,
    );
    return DONE;
  }

  const contacts = await selectEligible(campaign.teamId, campaign.bookId, {
    afterContactId: campaign.fanoutCursor,
    limit: CHUNK,
  });
  // Only an *empty* select can finish a campaign — a short chunk must not,
  // because a contact added mid-send sorts after the cursor and the next tick
  // is what picks it up. But an empty select has two possible meanings and
  // only one of them is "the book is walked out", so the other is ruled out
  // before the campaign is allowed to say it is sent. See {@link bookRefusal}
  // for why that check is inside this branch rather than above it.
  if (!contacts.length) {
    const gone = await bookRefusal(campaign);
    if (gone) {
      await notePaused(campaign, gone);
      return pausedResult(gone);
    }
    return finish(campaign, now);
  }

  // Checked here rather than above the empty-select test on purpose: a
  // campaign whose book is walked out owes nobody anything, and pausing it
  // for a domain it is no longer going to use would leave it `sending` for
  // ever instead of letting it finish.
  const domain = await domainRefusal(campaign, from.email);
  if (domain.refusal) {
    await notePaused(campaign, domain.refusal);
    return pausedResult(domain.refusal);
  }

  const [settings] = await db()
    .select({
      trackOpens: teamSettings.trackOpens,
      trackClicks: teamSettings.trackClicks,
    })
    .from(teamSettings)
    .where(eq(teamSettings.teamId, campaign.teamId))
    .limit(1);
  const tracking = {
    trackOpens: settings?.trackOpens ?? true,
    trackClicks: settings?.trackClicks ?? true,
  };
  const replyTo = campaign.replyTo
    ? [parseAddress(campaign.replyTo)?.email ?? campaign.replyTo]
    : [];

  // Whether any recipient needs per-recipient substitution at all, decided
  // once for the whole chunk: a campaign with no `{{ }}` keeps the fast path
  // — one stored render, rewritten only for the unsubscribe link — and pays
  // nothing for a feature it does not use.
  const merges = campaignUsesMerge(campaign);

  const planned: Planned[] = contacts.map((contact) => {
    const to = parseAddress(contact.email);
    // Nothing in `contacts` should fail this — the table has a check
    // constraint on the address — but a skipped recipient must leave a row
    // saying so. Silence would mean this contact is re-considered on every
    // tick and the campaign never finishes.
    if (!to) return { contact, emailId: null, skipReason: "invalid" };
    const emailId = newId("em");
    // One source for both links: the footer's and the header's must always
    // carry the same token, and they are two different routes.
    const links = unsubscribeLinks(contact.id, campaign.id);
    const personal = personalize(campaign, contact, merges);
    // A per-recipient render can only fail on size, and only a pathological
    // value reaches it; that one recipient is skipped rather than the whole
    // campaign stopped, and the skip row keeps it from being reconsidered.
    if (!personal)
      return { contact, emailId: null, skipReason: "personalize" as const };
    return {
      contact,
      emailId,
      row: {
        id: emailId,
        teamId: campaign.teamId,
        apiKeyId: null,
        // The domain that will actually carry this message, which is not
        // always the one the campaign names — see {@link domainRefusal}.
        domainId: domain.domainId,
        from: campaign.from,
        fromEmail: from.email,
        to: [to.email],
        replyTo,
        subject: personal.subject,
        ...body(personal, emailId, links.pageUrl, tracking),
        // Header-safe by construction rather than by hope: the names match
        // `HEADER_NAME` (`[A-Za-z0-9-]{1,80}`) and are not in the reserved
        // set, and the values satisfy `NO_CONTROL_CHARS` because a token is
        // base64url and `APP_URL` is a parsed `z.url()`. The fan-out inserts
        // `emails` rows directly, so `SendEmailInput` never validates these —
        // the guarantee has to hold at this end.
        headers: links.headers,
        ...tracking,
        status: "queued" as const,
        source: "campaign" as const,
        campaignId: campaign.id,
        contactId: contact.id,
      },
    };
  });

  // **Caps, once per chunk, immediately before the insert that would breach
  // them.** `createEmail` is the only other place `emails` rows are born and
  // it checks here too (per send, `adding: 1`); the fan-out writes rows
  // directly, so without this a campaign was counted by the billing meter and
  // by nothing else. `adding` is the number of rows this chunk would actually
  // create — not `contacts.length`, which counts recipients that will be
  // skipped rather than mailed, and refusing a chunk that fits is worse than
  // letting a handful through.
  const wanted = planned.filter(isMaterialised).length;
  const refusal = await capRefusal(campaign.teamId, wanted, now);
  if (refusal) {
    await notePaused(campaign, refusal);
    return pausedResult(refusal);
  }

  // The chunk's last contact in `selectEligible`'s order. Every contact up to
  // and including it is accounted for by a row written in the transaction
  // below, which is what makes advancing past it safe.
  const lastContactId = contacts[contacts.length - 1]!.id;

  const insertedIds = await db().transaction(async (tx) => {
    // Re-assert `sending` under a row lock. Without it a cancel landing
    // between the read above and this insert would still get a chunk's worth
    // of mail queued; with it, the cancel either commits first (and we see it
    // and do nothing) or waits for this chunk (and stops the next one).
    const [locked] = await tx
      .select({ status: campaigns.status })
      .from(campaigns)
      .where(eq(campaigns.id, campaign.id))
      .limit(1)
      .for("update");
    if (locked?.status !== "sending") return null;

    // **The double-send guard, and the reason the order is this way round.**
    // `on conflict do nothing … returning` returns only the rows this
    // statement actually inserted, so the returned contact ids are exactly
    // the recipients this call has claimed. Everything after keys off that
    // set — never off `planned`, which is what a second run would also build.
    //
    // The claim goes in with `email_id` still null and is linked below, and
    // that is forced rather than chosen: `campaign_recipients.email_id` is a
    // foreign key to `emails.id`, so naming the row here would need the email
    // to exist first — which would mean writing the `emails` rows *before*
    // knowing which recipients this call actually won, and then deleting the
    // ones it lost. The claim has to be the first write of the three, so the
    // link is the last.
    const claimed = await tx
      .insert(campaignRecipients)
      .values(
        planned.map((p) => ({
          campaignId: campaign.id,
          contactId: p.contact.id,
          status: (isMaterialised(p)
            ? "queued"
            : "skipped") as CampaignRecipientStatus,
          // A skipped recipient gets a row and a reason, never silence: the
          // row is what stops the same contact being reconsidered on every
          // tick, which is how a campaign would otherwise never finish.
          skipReason: isMaterialised(p) ? null : p.skipReason,
        })),
      )
      .onConflictDoNothing()
      .returning({ contactId: campaignRecipients.contactId });
    const won = new Set(claimed.map((r) => r.contactId));

    const winners = planned
      .filter(isMaterialised)
      .filter((p) => won.has(p.contact.id));
    const rows = winners.map((p) => p.row);
    if (rows.length) {
      await tx.insert(emails).values(rows);
      // The same `queued` timeline event `createEmail` writes, in bulk and
      // without `recordEvent`: that helper fires `notifyTeam` per call, and
      // 500 dashboard stream notifications for one chunk is a flood, not a
      // notification. A `queued` event moves no status, so the conditional
      // update `recordEvent` would run has nothing to do here either.
      await tx.insert(emailEvents).values(
        rows.map((r) => ({
          id: newId("evt"),
          emailId: r.id,
          teamId: campaign.teamId,
          type: "queued" as const,
          dedupeKey: `local:${r.id}:queued`,
          payload: { source: "campaign", campaignId: campaign.id },
          occurredAt: now,
        })),
      );
      // One statement rather than one per recipient: a chunk is 500 rows and
      // 500 round trips inside an open transaction is the kind of thing that
      // turns a lock hold into a timeout.
      await tx.execute(sql`
        update ${campaignRecipients} set email_id = v.email_id
        from (values ${sql.join(
          winners.map((p) => sql`(${p.contact.id}, ${p.emailId})`),
          sql`, `,
        )}) as v(contact_id, email_id)
        where ${campaignRecipients.campaignId} = ${campaign.id}
          and ${campaignRecipients.contactId} = v.contact_id
      `);
    }

    // Same transaction as the inserts, so a rollback cannot leave the cursor
    // past work that was never committed. `greatest` rather than a plain set:
    // two overlapping ticks can commit out of order, and a cursor that moved
    // backwards would re-walk a window (harmless, the primary key absorbs it)
    // — but a cursor that can move at all in the wrong direction is one
    // refactor away from skipping one instead.
    await tx
      .update(campaigns)
      .set({
        fanoutCursor: sql`greatest(coalesce(${campaigns.fanoutCursor}, ''), ${lastContactId})`,
      })
      .where(
        and(eq(campaigns.id, campaign.id), eq(campaigns.status, "sending")),
      );

    return rows.map((r) => r.id);
  });

  // Cancelled while we held nothing: no rows, no cursor movement.
  if (insertedIds === null) return DONE;

  // **Only rows this call inserted get a job.** A row someone else inserted
  // already has one (or will be swept), and enqueueing for it would hand the
  // same email to two workers — which the atomic claim in `sendQueuedEmail`
  // survives, but only by luck rather than by design.
  //
  // Outside the transaction on purpose: the rows are committed, and pg-boss
  // being down must not roll back a chunk. `email.queued-sweep` re-enqueues
  // due `queued` rows untouched for 5 minutes, which is exactly this failure.
  for (const emailId of insertedIds) {
    try {
      await deps.enqueue(Q.emailSend, { emailId });
    } catch (e) {
      console.error(
        `[campaigns] enqueue failed for ${emailId}; the queued sweep will pick it up:`,
        e,
      );
    }
  }

  const skipped = planned.filter((p) => p.emailId === null).length;
  return {
    materialised: insertedIds.length,
    skipped,
    done: false,
    completed: false,
  };
}

export interface StartResult {
  /** This call is the one that flipped `scheduled` → `sending`. */
  started: boolean;
  /**
   * Why it did not start, when the campaign was left `scheduled` on purpose
   * so a later tick can try again. Absent when another worker simply got
   * there first, or when the campaign was edited out of `scheduled`.
   */
  deferred?: Refusal;
}

/**
 * `scheduled` → `sending`: render once, store the render, stamp `startedAt`.
 *
 * This is the only thing `campaign.start-sweep` does per campaign, and it
 * enqueues nothing — `campaign.fan-out-sweep` finds the campaign on its own
 * next tick, because the fan-out's continuation is a cron and never a job
 * that schedules itself (property 3 above).
 *
 * ## The flip is a conditional UPDATE, not a read-then-write
 *
 * The read above is for the refusals; the `where` is what makes the flip
 * safe. Two things race it. A second sweep worker on the same tick would
 * otherwise both render (CPU) and both stamp `startedAt` (two different
 * answers to "when did this start?"). And `crud.ts` re-asserts the status in
 * the `where` of its own writes for the mirror image of this reason — an edit
 * landing between our read and our write is exactly the half-sent incoherence
 * that check exists to prevent. Only the worker whose UPDATE returns a row
 * has started the campaign; every other caller reports `started: false` and
 * touches nothing.
 *
 * ## Why nothing here cancels
 *
 * A `scheduled` campaign that cannot be sent right now is left `scheduled`,
 * audited once, and reconsidered next tick. It has mailed nobody, so there is
 * no half-sent state to resolve, and `scheduled` is still editable
 * (`EDITABLE_STATUSES`) — so the customer can fix the address, the blocks or
 * the domain and the campaign goes out, where `cancelled` would be a terminal
 * status they cannot edit their way out of. The refusals that end a campaign
 * ({@link stopCampaign}) exist because it is already `sending`; that is not
 * this situation.
 *
 * The cost of that choice is a campaign that sits `scheduled` past its time
 * with only an audit row to say why, which is why the audit row is not
 * optional.
 */
export async function startCampaign(
  campaignId: string,
  opts: { now?: Date } = {},
): Promise<StartResult> {
  const now = opts.now ?? new Date();
  const [campaign] = await db()
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  // Deleted, edited back to `draft`, or started by another worker between the
  // sweep's select and this read.
  if (!campaign || campaign.status !== "scheduled") return { started: false };

  const from = parseAddress(campaign.from);
  if (!from)
    return defer(campaign, {
      code: "validation_error",
      message: `The from address ${campaign.from} is not a valid address.`,
    });
  // The defect this re-check exists for: `crud.ts` proved the domain was
  // verified when the campaign was authored, and a campaign can be scheduled
  // days ahead of its send. See {@link domainRefusal}.
  const { refusal } = await domainRefusal(campaign, from.email);
  if (refusal) return defer(campaign, refusal);
  // The book, for exactly the same reason and at exactly the same moment: it
  // carries no foreign key either, and a campaign scheduled for Thursday can
  // reach Thursday with its audience deleted. Without this the campaign flips
  // to `sending`, the first chunk selects nobody, and it reports itself
  // `sent` to nought recipients — the worst version of the lie in
  // {@link bookRefusal}, because not one person was mailed. Deferring leaves
  // it `scheduled`, which is still editable, so the customer can point it at
  // a book that exists and send it.
  const gone = await bookRefusal(campaign);
  if (gone) return defer(campaign, gone);

  let rendered;
  try {
    // **Once per campaign, here** — property 4 above. Storing the result is
    // what stops an edit to `blocks` mid-send giving the first and the last
    // recipient different mail; `ensureRendered` is only the fallback for a
    // campaign that reached `sending` without passing through here.
    rendered = renderBlocks(await composeBody(campaign), {
      theme: campaign.theme ?? undefined,
    });
  } catch (e) {
    if (!(e instanceof InvalidCampaignBlockError)) throw e;
    return defer(campaign, {
      code: "validation_error",
      message: `The body cannot be rendered — block ${e.index}: ${e.message}`,
    });
  }

  const [row] = await db()
    .update(campaigns)
    .set({
      status: "sending",
      startedAt: now,
      html: rendered.html,
      text: rendered.text,
    })
    .where(
      and(eq(campaigns.id, campaign.id), eq(campaigns.status, "scheduled")),
    )
    .returning({ id: campaigns.id });
  if (!row) return { started: false };
  console.info(`[campaigns] ${campaign.id} started`);
  await recordAudit({
    teamId: campaign.teamId,
    actorUserId: null,
    action: "campaigns.started",
    targetType: "campaign",
    targetId: campaign.id,
    diff: { status: { from: "scheduled", to: "sending" } },
  });
  return { started: true };
}

/**
 * Leave the campaign `scheduled`, record why once, and report it.
 *
 * {@link notePaused} is shared with the fan-out deliberately: a campaign the
 * start sweep refuses is asked again every single minute until someone fixes
 * it or deletes it, so without its per-reason de-duplication this would be
 * the noisiest thing in the audit log.
 */
async function defer(
  campaign: Campaign,
  refusal: Refusal,
): Promise<StartResult> {
  await notePaused(campaign, refusal);
  return { started: false, deferred: refusal };
}

/** The audit action a paused campaign writes, once per campaign per reason. */
const PAUSED_ACTION = "campaigns.paused";

/**
 * The reason this campaign's contact book is gone, or null.
 *
 * ## The hole this closes
 *
 * The fan-out's finish condition is an empty chunk, and `contacts.book_id`
 * cascades from `contact_books` while `campaigns.book_id` carries no foreign
 * key at all (see `db/schema/campaigns.ts` for why there is no `restrict`
 * anywhere in this schema). Delete a book while a campaign over it is
 * `sending` and every contact in it goes at once; the next chunk selects
 * nothing; {@link fanoutChunk} reads that as "the book is walked out" and
 * calls {@link finish}.
 *
 * That is the only one of this file's four guard gaps with **no downstream
 * symptom whatsoever**. An unverified domain fails per message; a cap shows
 * up on a bill; unrendered blocks throw. This one writes `status = 'sent'`
 * and a `sent_at`, fires the `campaign.sent` webhook into the customer's
 * automation, and stops — and nothing in the product ever disagrees. The
 * customer is told a 50 000-recipient campaign completed when 12 000 people
 * received it, and there is nowhere they could look to find out otherwise.
 *
 * ## Why the check is inside the empty branch and not above it
 *
 * Ordering matters in both directions here. Task 8 put {@link domainRefusal}
 * *after* the empty-select test because a campaign whose book is genuinely
 * walked out owes nobody anything, and pausing it over a domain it will never
 * use again would strand it `sending` for ever instead of letting it finish.
 * This check has to go the other way — it is precisely the finish that is
 * wrong — so it is asked only **when the select came back empty**, which
 * keeps both properties at once: an ordinary chunk pays nothing for it, a
 * campaign that really has walked its book out still finishes normally on the
 * very same tick, and the only behaviour that changes is the one that was a
 * lie. It is one indexed read on the single tick of a campaign's life that
 * would otherwise complete it.
 *
 * The question is "does this book still exist for this team?" rather than
 * "did the select return rows?", and it is scoped by team for the reason
 * `crud.ts` gives for scoping its joins: an id is not proof of ownership.
 *
 * ## Why this pauses rather than stops
 *
 * This is the hardest of the four to place on the reversible/irreversible
 * line {@link notePaused} draws, and it does not sit cleanly on either side.
 * A deleted book is *not* reversible the way an unverified domain is: the
 * contacts went with it, re-importing them mints new ULIDs, and a re-created
 * book gets a new id that this campaign's `book_id` will never name — so
 * unlike every other pause in this file, this one does not resume by itself.
 * Only restoring the book row under its original id brings it back, and
 * nothing in the product does that.
 *
 * It pauses anyway, for two reasons.
 *
 * First, **pausing cannot lie and finishing can**. That is the entire defect:
 * `sent` is a claim about the audience, and the one thing this code must
 * never do again is make that claim without having walked the audience. A
 * paused campaign is `sending` with an audit row naming the book that
 * vanished — visibly unfinished, which is the truth.
 *
 * Second, and this is what settles it against {@link stopCampaign}: cancelling
 * is **terminal and immutable** (`crud.ts`), and it is a decision only the
 * person who owns the audience can make. Their route out of a cancelled
 * campaign is a second campaign over a rebuilt book, which has its own
 * `campaign_recipients` rows and therefore re-mails everyone who already
 * received the first half — the exact duplicate send {@link notePaused}
 * refuses to force on a customer. If the deletion was a mistake and the book
 * is restored, a paused campaign resumes from its cursor and finishes
 * correctly; a cancelled one cannot be recovered at all. So the cron records
 * the fact and stops, and `cancelCampaign` stays where it belongs — with a
 * human, who can reach it the moment they see the pause.
 *
 * The price is a campaign that can sit `sending` indefinitely, holding one of
 * the sweep's `SWEEP_BATCH` slots every minute (see
 * `jobs/handlers/campaign-fanout.ts`, where that starvation is already a
 * recorded Phase 8 opener). That is an operational cost paid in scheduling;
 * the alternative was paid in someone's inbox.
 *
 * ## And it should almost never be reached
 *
 * `deleteBook` now refuses while a campaign over the book is `sending`
 * (`services/contacts.ts`), which is where a customer meets this problem —
 * with a message naming the campaign to cancel, rather than a campaign that
 * silently died. This is the backstop for what that check cannot cover: the
 * race between it and the start sweep, a book deleted before this shipped,
 * and anything that reaches the table without going through the service.
 */
async function bookRefusal(campaign: Campaign): Promise<Refusal | null> {
  const [book] = await db()
    .select({ id: contactBooks.id })
    .from(contactBooks)
    .where(
      and(
        eq(contactBooks.id, campaign.bookId),
        eq(contactBooks.teamId, campaign.teamId),
      ),
    )
    .limit(1);
  if (book) return null;
  return {
    code: "not_found",
    message:
      "The contact book this campaign sends to no longer exists, so the rest of its audience cannot be reached. Cancel the campaign, or restore the book to let it finish.",
  };
}

/**
 * The domain this chunk's messages will be sent from, or the reason there is
 * none — checked **once per chunk, not once per recipient**.
 *
 * ## The hole this closes
 *
 * `crud.ts` proves the domain is verified when a campaign is created or
 * edited, and `campaigns.domain_id` deliberately carries no foreign key, so
 * nothing at all re-asserts it afterwards. Between authoring and the last
 * chunk the domain can be deleted, or fail a re-verification (`domain.verify`
 * demotes a `verified` domain the moment SES disagrees), and the fan-out will
 * happily go on stamping its id onto rows that then fail **one at a time**:
 * 38 000 individual `MessageRejected` responses, 38 000 `failed` rows, one
 * ruined sender reputation, and no single place that says why.
 *
 * The deleted case is worse still and is the one that made this urgent:
 * `emails.domain_id` *does* have a foreign key (`set null`), so inserting a
 * chunk that names a deleted domain raises a foreign-key violation and takes
 * the whole transaction with it — a campaign that throws on every sweep tick
 * for ever, materialising nothing and explaining nothing.
 *
 * ## Why the question is "is there a verified domain for this address?"
 *
 * Not "is `campaigns.domain_id` still verified?". {@link resolveSendingDomain}
 * is the notion `createEmail` uses before every API send — longest-suffix
 * match over the team's `verified` domains — so asking it here means a
 * campaign and an API send cannot disagree about whether this `from` is
 * sendable right now, the same reasoning {@link capRefusal} gives for reusing
 * `checkTeamCaps`.
 *
 * It also makes the answer *recoverable in both directions*, which is what
 * lets this pause rather than stop (below). Re-adding a deleted domain mints
 * a **new** id, so an id-based check could never be satisfied again; a
 * name-based one is satisfied the moment the domain is verified again, under
 * whatever id.
 *
 * The corollary is that the resolved domain is not always the campaign's:
 * verifying a more specific subdomain mid-send moves the longest-suffix match
 * onto it, and a campaign whose own domain was deleted can still resolve to a
 * verified parent. Both send perfectly well — SES verifies identities, not
 * our rows — so the resolved id is what goes on the `emails` row, which keeps
 * the mail log pointing at the identity that actually carried the message and
 * keeps that foreign key satisfiable.
 *
 * ## Why this pauses rather than cancels
 *
 * The reversibility test {@link notePaused} sets out, applied to this fact: a
 * domain that has fallen out of verification is re-verified by
 * `domain.verify-sweep` within minutes of the DNS being fixed, and a deleted
 * one is recovered by re-adding it. So the campaign is left `sending` with
 * its cursor where it is and resumes by itself from the exact recipient it
 * stopped at — where `cancelled` is immutable (`crud.ts`), and the only route
 * back would be a second campaign over the same book, mailing everyone who
 * already received the first half a second time. Stopping a *reversible*
 * refusal buys nothing and costs a duplicate send.
 *
 * That is the whole of the difference from the two refusals that do call
 * {@link stopCampaign}: an unparseable `from` and blocks that no longer
 * render are properties of the campaign's own stored data, and no amount of
 * waiting makes them valid.
 */
async function domainRefusal(
  campaign: Campaign,
  fromEmail: string,
): Promise<
  | { refusal: Refusal; domainId?: undefined }
  | { refusal: null; domainId: string }
> {
  const domain = await resolveSendingDomain(campaign.teamId, fromEmail);
  if (domain) return { refusal: null, domainId: domain.id };
  return {
    refusal: {
      code: "domain_not_verified",
      message: `No verified sending domain for ${fromEmail}. The campaign resumes from where it stopped once the domain is verified again.`,
    },
  };
}

/**
 * The cap this chunk would breach, or null.
 *
 * Both checks are the ones `createEmail` runs, called in the same order with
 * the same clock, which is the whole point: a campaign and an API send must
 * not disagree about whether a team may send right now. In particular
 * `checkTeamCaps` resolves the team's caps through `resolveTeamCaps`, so a
 * campaign inherits the billing entitlement rules exactly — the past-due grace
 * period, the cancelled-at-period-end cut-off, the operator's per-team
 * override in `team_settings` winning over the plan, and (on a self-hosted
 * instance, where `BILLING_ENABLED` is off) no plan cap at all. There is no
 * second opinion here to drift from the first.
 *
 * **Neither check consumes anything.** Both are pure reads: `checkTeamCaps`
 * counts `emails` rows in `SEND_CONSUMING_STATUS` created inside the window
 * and compares `count + adding` against the cap; `checkAccountQuota` counts
 * rows SES accepted (`sent_at`) in the trailing 24 h. Nothing is reserved and
 * nothing is decremented, so calling this per chunk and then failing to
 * materialise leaks no quota — a chunk that rolls back is simply not counted
 * next time. It also means the count rises as chunks commit, so a campaign is
 * measured against its own earlier chunks without any bookkeeping of its own.
 *
 * The corollary is that the caps are soft, exactly as they are for
 * `createEmail`: check-then-insert is not atomic, so a campaign chunk and a
 * concurrent API send can each pass and jointly overshoot. Per chunk that is
 * bounded by {@link CHUNK}.
 *
 * ## A chunk is all-or-nothing, so the last part-chunk of an allowance is unused
 *
 * `checkTeamCaps` takes a count and answers yes or no; asked for 500 with 200
 * left it says no, and this stops the campaign with 200 of the allowance
 * unspent. Trimming the chunk to fit was considered and rejected: it needs a
 * second way to compute "how many remain" beside the one `checkTeamCaps`
 * already owns, it buys under one chunk of mail (0.4 % of a 50 000-recipient
 * campaign), and it arrives at the same stop one tick later. Refusing whole
 * requests is also what the API path does — `createEmail` refuses a batch item
 * rather than truncating it.
 */
async function capRefusal(
  teamId: string,
  adding: number,
  now: Date,
): Promise<Refusal | null> {
  if (adding <= 0) return null;
  const caps = await checkTeamCaps(teamId, adding, now);
  if (!caps.ok) return { code: caps.code, message: caps.message };
  const quota = await checkAccountQuota(teamId, adding, now);
  if (!quota.ok) return { code: quota.code, message: quota.message };
  return null;
}

/**
 * Record that something paused this campaign — once, not once a minute.
 *
 * Three facts reach here: a send cap ({@link capRefusal}), a sending domain
 * that is no longer verified ({@link domainRefusal}) and a contact book that
 * has been deleted ({@link bookRefusal}). They are recorded the same way, and
 * the first two pause for the same reason; the text below is written about
 * the cap because it is the one whose alternative is tempting, and
 * {@link bookRefusal} carries its own argument because it is the one fact
 * here that does *not* stop being true on its own.
 *
 * ## Why a cap pauses rather than cancels
 *
 * The other two campaign-level refusals in this file (an unparseable `from`,
 * blocks that no longer render) call {@link stopCampaign} and end the campaign
 * as `cancelled`, because no amount of retrying makes them true again. A cap
 * is the opposite kind of fact: it stops being true on its own, when the
 * billing period rolls over, or the moment the customer upgrades or the
 * operator raises `team_settings.monthly_limit`. So the campaign is left
 * `sending` with its cursor where it is, this tick materialises nothing, and
 * the sweep's next tick simply asks again — the campaign resumes by itself,
 * from the exact recipient it stopped at, and finishes.
 *
 * Cancelling instead would be actively harmful, not merely unhelpful. A
 * `cancelled` campaign cannot be restarted (see `crud.ts`: `sending`, `sent`
 * and `cancelled` are immutable), so the only route left to a customer who has
 * just paid to lift the cap is to create a *new* campaign over the same book —
 * and a new campaign has its own `campaign_recipients` rows, so the 12 000
 * people who already received the first half would receive it again. The cure
 * would be a duplicate send to a third of the audience.
 *
 * Letting it finish was never an option: it is the revenue hole the cap
 * exists to close, and on a self-hosted instance it is an operator's
 * deliberate SES-quota setting being ignored.
 *
 * ## Why this is on the audit trail, and why only once
 *
 * A campaign that stops at 12 000 of 50 000 with no explanation is the worst
 * outcome available, so the pause is a fact somebody can look up: the same
 * `campaigns.*` audit row `stopCampaign` writes, carrying the cap that
 * refused and its customer-facing message. `paused` on {@link FanoutResult}
 * carries the same pair to the sweep, so the dashboard and the API can say it
 * too without re-deriving it.
 *
 * It is written once per campaign per cap rather than once per tick, because
 * a paused campaign is asked again every minute for as long as the cap holds —
 * potentially the rest of a billing month — and an audit log with forty
 * thousand identical rows in it has no signal left. Keyed on the cap's code so
 * a campaign that later hits a *different* cap still records that; the
 * existence query runs only on the refusal path, which is the path that is
 * already not materialising anything.
 *
 * The `console.warn` sits **after** that existence check for the same reason:
 * everything a paused tick would otherwise repeat — the audit row, the log
 * line, and (in the sweep) the progress line — has to be de-duplicated here,
 * because this is the only place that knows the refusal is not new.
 */
async function notePaused(campaign: Campaign, refusal: Refusal): Promise<void> {
  const [existing] = await db()
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetId, campaign.id),
        eq(auditLog.action, PAUSED_ACTION),
        sql`${auditLog.diff} -> 'reason' ->> 'to' = ${refusal.code}`,
      ),
    )
    .limit(1);
  if (existing) return;
  console.warn(
    `[campaigns] ${campaign.id} paused (${refusal.code}): ${refusal.message}`,
  );
  await recordAudit({
    teamId: campaign.teamId,
    actorUserId: null,
    action: PAUSED_ACTION,
    targetType: "campaign",
    targetId: campaign.id,
    diff: {
      reason: { to: refusal.code },
      detail: { to: refusal.message },
    },
  });
}

/** `sending` → `sent`. Guarded, so only one tick can be the one that finishes. */
async function finish(campaign: Campaign, now: Date): Promise<FanoutResult> {
  // `counts` is deliberately not refreshed here: it is a cache derived from
  // `emails`/`email_events` (Decision 8) and the sweep that calls this owns
  // refreshing it, which also keeps this module free of `stats.ts`.
  const [row] = await db()
    .update(campaigns)
    .set({ status: "sent", sentAt: now })
    .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "sending")))
    .returning({ id: campaigns.id });
  return { ...DONE, completed: Boolean(row) };
}

/**
 * The stored render, rendering and storing it if it is not there yet.
 *
 * Normally a no-op: `campaign.start-sweep` renders when it flips a campaign to
 * `sending`. It is here anyway because this module must not depend on that
 * having happened — and because it gives {@link InvalidCampaignBlockError} one
 * place to be handled.
 *
 * Returns `null` when the campaign was stopped instead.
 */
async function ensureRendered(campaign: Campaign): Promise<Campaign | null> {
  if (campaign.html !== null && campaign.text !== null) return campaign;
  let rendered;
  try {
    rendered = renderBlocks(await composeBody(campaign), {
      theme: campaign.theme ?? undefined,
    });
  } catch (e) {
    if (!(e instanceof InvalidCampaignBlockError)) throw e;
    // **A campaign that cannot render is stopped, not retried.** It is
    // `sending`, so every sweep tick would try again, throw again and log
    // again — a stuck campaign that raises an exception every minute is its
    // own incident, and no amount of retrying will make an invalid stored
    // block valid. `cancelled` is the honest terminal state (it means
    // "stopped part-way", it is unreachable from anywhere but `sending`, and
    // the sweep does not select it), and the audit row carries which block
    // and why so the refusal is diagnosable rather than merely silent.
    await stopCampaign(
      campaign,
      "invalid_blocks",
      `block ${e.index}: ${e.message}`,
    );
    return null;
  }
  const [row] = await db()
    .update(campaigns)
    .set({ html: rendered.html, text: rendered.text })
    .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "sending")))
    .returning();
  // Cancelled underneath us; the caller's status re-check catches it.
  return row ?? null;
}

/**
 * `sending` → `cancelled`, once, with a reason on the audit trail.
 *
 * Used only for the campaign-level refusals that no retry can fix. Guarded on
 * `sending` so a cancel that beat us here is left alone, and audited rather
 * than logged only, because "why did this campaign stop half way?" is a
 * question asked days later.
 */
async function stopCampaign(
  campaign: Campaign,
  reason: string,
  detail: string,
): Promise<void> {
  const [row] = await db()
    .update(campaigns)
    .set({ status: "cancelled" })
    .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "sending")))
    .returning({ id: campaigns.id });
  if (!row) return;
  console.error(`[campaigns] ${campaign.id} stopped (${reason}): ${detail}`);
  await recordAudit({
    teamId: campaign.teamId,
    actorUserId: null,
    action: "campaigns.stopped",
    targetType: "campaign",
    targetId: campaign.id,
    diff: {
      status: { from: "sending", to: "cancelled" },
      reason: { to: reason },
      detail: { to: detail },
    },
  });
}

/**
 * One recipient's body: the campaign's stored render, tracked for this email
 * id, with the marker swapped for this recipient's link.
 *
 * ## Why the replacement is a function
 *
 * `String.prototype.replace` with a string replaces only the **first**
 * occurrence, and in *either* `replace` or `replaceAll` a string replacement
 * is a substitution pattern: `$&`, `$'`, `` $` `` and `$1` in it are expanded
 * against the match. The replacement here is a generated URL. A base64url
 * token has no `$`, so a string replacement passes every test that will ever
 * be written and then mangles exactly one recipient's link the day `APP_URL`
 * or the footer markup grows one. The function form has no substitution
 * semantics at all, so the question cannot arise.
 *
 * ## Why tracking is applied before the substitution
 *
 * `wrapLinks` would otherwise rewrite the unsubscribe anchor into a click
 * tracker, so leaving a campaign would be counted as engagement with it and
 * every unsubscribe would take an extra redirect hop. Applying tracking to the
 * stored render first leaves the marker (a control character, matched by no
 * href pattern) untouched and the unsubscribe link direct.
 *
 * This is per-recipient *rewriting*, not per-recipient *rendering*:
 * `renderBlocks` still runs once per campaign, and tracking URLs are keyed by
 * the email id exactly as they are for an API send, which is what makes
 * per-campaign open and click counts possible at all.
 */
function body(
  src: { html: string; text: string },
  emailId: string,
  url: string,
  opts: { trackOpens: boolean; trackClicks: boolean },
): { html: string; text: string } {
  const env = loadEnv();
  let html = src.html;
  if (opts.trackClicks)
    html = wrapLinks(html, emailId, env.APP_URL, env.APP_SECRET);
  if (opts.trackOpens) html = injectPixel(html, emailId, env.APP_URL);
  const footer = `<a href="${escapeHtml(url)}">Unsubscribe</a>`;
  return {
    html: html.replaceAll(UNSUBSCRIBE_MARKER, () => footer),
    text: src.text.replaceAll(UNSUBSCRIBE_MARKER, () => `Unsubscribe: ${url}`),
  };
}

/**
 * The body with its linked header and footer layouts composed around it,
 * resolved to the layouts' **current** blocks at this moment — which is what
 * makes a header edit propagate to every not-yet-sent campaign. A slot with no
 * id, or an id whose layout was deleted, is simply empty. Rendered once at
 * send start; `ensureRendered` uses it too for the crashed-mid-start case.
 */
async function composeBody(campaign: Campaign): Promise<CampaignBlock[]> {
  const ids = [campaign.headerLayoutId, campaign.footerLayoutId].filter(
    (v): v is string => v !== null,
  );
  if (ids.length === 0) return campaign.blocks;
  const rows = await db()
    .select({ id: teamLayouts.id, blocks: teamLayouts.blocks })
    .from(teamLayouts)
    .where(
      and(
        eq(teamLayouts.teamId, campaign.teamId),
        inArray(teamLayouts.id, ids),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r.blocks]));
  return withHeaderFooter(
    campaign.blocks,
    campaign.headerLayoutId ? byId.get(campaign.headerLayoutId) : null,
    campaign.footerLayoutId ? byId.get(campaign.footerLayoutId) : null,
  );
}

/** Does this campaign use any merge field anywhere the fan-out substitutes? */
function campaignUsesMerge(c: Campaign): boolean {
  return (
    placeholderCount(c.subject) +
      placeholderCount(c.html ?? "") +
      placeholderCount(c.text ?? "") >
    0
  );
}

/**
 * One recipient's subject and body with `{{ name }}` merge fields resolved
 * against this contact and the campaign's fallbacks. The fast path — a
 * campaign with no merge fields — returns the stored render untouched, so it
 * is exactly what it was before merge existed. Null only on the size-overflow
 * error, which drops the one recipient.
 *
 * The stored `html` still carries {@link UNSUBSCRIBE_MARKER} (a control
 * character, matched by no placeholder) at this point; `body()` swaps it for
 * the recipient's link afterwards.
 */
function personalize(
  campaign: Campaign,
  contact: EligibleContact,
  merges: boolean,
): { subject: string; html: string; text: string } | null {
  const fields = {
    subject: campaign.subject,
    html: campaign.html ?? "",
    text: campaign.text ?? "",
  };
  if (!merges) return fields;
  const r = renderCampaignFields(
    fields,
    {
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      properties: contact.properties ?? {},
    },
    campaign.mergeDefaults ?? {},
  );
  if ("error" in r) {
    console.warn(
      `[campaigns] ${campaign.id}: recipient ${contact.id} skipped, personalise: ${r.error}`,
    );
    return null;
  }
  return r;
}
