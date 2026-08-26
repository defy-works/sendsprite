import type {
  AudiencePreview,
  CampaignCounts,
  CampaignStatus,
} from "@sendsprite/shared";
import { formatWhen } from "@/lib/format";

/**
 * The pure half of the send screen: the audience arithmetic, the pre-flight
 * cap comparison, the copy of both irreversible dialogs, and the map from a
 * campaign's status to what the page may offer.
 *
 * A module rather than logic inside the components, for the reason
 * `preview.ts` gives — there is no React test environment in this repo, so
 * anything worth asserting has to live where vitest can reach it. Here that is
 * sharper than it was for the block editor, because what these functions get
 * wrong is not a mis-rendered card: it is a number a customer reads once,
 * before mailing their entire list, in the one place in this product where
 * there is no undo.
 *
 * Three things in particular are here because they are *claims about numbers*
 * and claims should be testable:
 *
 * 1. {@link audienceBreakdown} — the excluded count. The four numbers on the
 *    audience card are four views of one population, not four buckets that sum
 *    to it, and a card that printed a sum which does not add up would be
 *    teaching the customer to distrust the one number that matters.
 * 2. {@link capPreflight} — whether this send fits in the team's remaining
 *    allowance. The fan-out already pauses a campaign that exceeds it, but
 *    finding that out at recipient 12 000 of 50 000 is a bad way to learn it.
 * 3. {@link confirmationMatches} — the typed confirmation. The friction is the
 *    feature; it is not decoration and it is not only in the browser (see
 *    `actions.ts`, which re-checks the same string server-side because a
 *    server function is a POST endpoint, not a button).
 */

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/** Grouped digits, fixed locale — the same call every other panel makes. */
export const formatCount = (n: number): string => n.toLocaleString("en-US");

/** "1 person" / "940 people". Recipients are people; say so. */
export const people = (n: number): string =>
  `${formatCount(n)} ${n === 1 ? "person" : "people"}`;

/**
 * `part / whole` as a percentage, or `null` when the denominator is zero.
 *
 * `null` rather than `0%`: a campaign that has queued nothing yet has no open
 * rate, and printing `0%` for "not measured" is the same class of mistake as
 * printing a sum that does not add up.
 */
export function rate(part: number, whole: number): string | null {
  if (whole <= 0) return null;
  const pct = (part / whole) * 100;
  // One decimal below 10 %, none above: "0.4 %" is a real distinction between
  // a bad complaint rate and a catastrophic one, "63.2 %" is false precision.
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/* ------------------------------------------------------------------ *
 * The audience
 * ------------------------------------------------------------------ */

/**
 * The audience card's numbers, with the two derived ones the customer
 * actually asks about.
 *
 * `audiencePreview` returns four counts over one population: every contact in
 * the book, the ones who still consent, the ones whose address is suppressed,
 * and the ones that are both consenting and not suppressed. They do **not**
 * partition the book — `suppressed` and the unsubscribed overlap, and
 * `eligible` is a subset of `subscribed` — so the only honest "excluded"
 * number is `contacts - eligible`, which counts a contact excluded for both
 * reasons exactly once.
 *
 * {@link AudienceBreakdown.both} is that overlap, recovered by inclusion
 * exclusion: `|¬subscribed ∪ suppressed| = |¬subscribed| + |suppressed| −
 * |¬subscribed ∩ suppressed|`, so the intersection is
 * `unsubscribed + suppressed − excluded`. Having it means the card can show
 * the two reasons *and* an excluded total that adds up, instead of two numbers
 * that mysteriously over-count.
 *
 * Every derived number is clamped at zero. The four inputs come from a single
 * aggregate and cannot disagree with each other today; a clamp costs nothing
 * and means a future query that does disagree renders a slightly wrong card
 * rather than "-3 people excluded".
 */
export interface AudienceBreakdown extends AudiencePreview {
  /** Contacts who have withdrawn consent for this book: `contacts - subscribed`. */
  unsubscribed: number;
  /** Contacts this campaign will not reach: `contacts - eligible`. */
  excluded: number;
  /** Excluded for both reasons at once, counted once in `excluded`. */
  both: number;
}

export function audienceBreakdown(p: AudiencePreview): AudienceBreakdown {
  const clamp = (n: number) => Math.max(0, n);
  const unsubscribed = clamp(p.contacts - p.subscribed);
  const excluded = clamp(p.contacts - p.eligible);
  return {
    ...p,
    unsubscribed,
    excluded,
    both: clamp(unsubscribed + p.suppressed - excluded),
  };
}

/**
 * The one-line explanation of each exclusion, in the customer's terms.
 *
 * Written as *what the person did*, not as *what our schema says*. "Not
 * subscribed" is a database state; "they asked not to receive this" is the
 * fact that makes it right to leave them out, and it is the sentence that
 * stops a support ticket asking to send to them anyway.
 */
export const UNSUBSCRIBED_REASON =
  "They asked not to receive mail like this. Consent is per contact book, so " +
  "they can still get transactional mail such as a receipt or a password reset.";

export const SUPPRESSED_REASON =
  "Their address hard-bounced or reported a previous message as spam. " +
  "Sending to it again damages your own delivery for everyone else, so it is " +
  "held back across every campaign on this team.";

/* ------------------------------------------------------------------ *
 * The pre-flight cap check
 * ------------------------------------------------------------------ */

/**
 * The fields of `UsageSnapshot` this module reads.
 *
 * Declared structurally rather than imported: `services/send-limits.ts`
 * reaches the database at module scope, and this file is imported by client
 * components. A `UsageSnapshot` satisfies it, so the page's hand-off is still
 * typechecked at the call site.
 */
export interface TeamAllowance {
  dailyLimit: number | null;
  dailyUsed: number;
  monthlyLimit: number | null;
  monthlyUsed: number;
  /** Exclusive end of the monthly window: when the allowance renews. */
  monthlyUntil: Date;
  instanceQuota: number | null;
  instanceUsed: number;
}

export interface Allowance {
  kind: "daily" | "monthly" | "instance";
  /** How the dialog names it, mid-sentence. */
  label: string;
  limit: number;
  used: number;
  /** `limit - used`, clamped: never negative even after a soft overshoot. */
  remaining: number;
  /** When this allowance next resets, phrased for the dialog, or `null`. */
  renews: string | null;
}

export interface CapPreflight {
  /** Every cap that actually measured this team, tightest remainder first. */
  allowances: Allowance[];
  /** The tightest cap this send would exceed, or `null` if it fits. */
  exceeded: Allowance | null;
  /** Recipients beyond that cap. `0` when the send fits. */
  over: number;
}

/**
 * Whether this campaign fits in what the team has left to send.
 *
 * The fan-out checks the same caps per chunk and **pauses** the campaign when
 * one refuses — it does not cancel, and it resumes by itself when the window
 * rolls over or the cap is raised. That is the right behaviour and it is still
 * a bad surprise: a campaign that stops at 12 000 of 50 000 has split one
 * announcement into two, hours or weeks apart, for reasons the recipients
 * cannot see. So the comparison is made here, before anything leaves, and it
 * is made against the same three limits `capRefusal` uses.
 *
 * ## Why the instance quota is sometimes not measured
 *
 * `usageSnapshot` skips the instance-wide scan whenever the team has a cap of
 * its own, and reports `instanceUsed: 0` in that case. Believing that would
 * print "SES 24-hour quota: 0 of 50 000 used" on a busy instance — a confident
 * false number, which is worse than no number. So the instance allowance is
 * included **only** when neither team cap is set, which is exactly when the
 * snapshot measured it.
 *
 * ## The remaining allowance is an upper bound, not a promise
 *
 * The caps are soft (`checkTeamCaps` is check-then-insert, and the fan-out
 * materialises in chunks of 500 which are all-or-nothing), so a send that
 * "fits" with 200 to spare can still stop one chunk early, and other sends —
 * an API call, another campaign — spend from the same allowance meanwhile.
 * The copy says "about", and means it.
 */
export function capPreflight(
  eligible: number,
  usage: TeamAllowance,
): CapPreflight {
  const allowances: Allowance[] = [];
  const add = (
    kind: Allowance["kind"],
    label: string,
    limit: number | null,
    used: number,
    renews: string | null,
  ) => {
    if (limit === null) return;
    allowances.push({
      kind,
      label,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      renews,
    });
  };

  add(
    "daily",
    "your daily send limit",
    usage.dailyLimit,
    usage.dailyUsed,
    null,
  );
  add(
    "monthly",
    "your monthly send allowance",
    usage.monthlyLimit,
    usage.monthlyUsed,
    formatWhen(usage.monthlyUntil),
  );
  // Only when the snapshot actually counted it — see the doc comment.
  if (usage.dailyLimit === null && usage.monthlyLimit === null)
    add(
      "instance",
      "this instance's 24-hour SES quota",
      usage.instanceQuota,
      usage.instanceUsed,
      null,
    );

  allowances.sort((a, b) => a.remaining - b.remaining);
  const exceeded = allowances.find((a) => eligible > a.remaining) ?? null;
  return {
    allowances,
    exceeded,
    over: exceeded ? eligible - exceeded.remaining : 0,
  };
}

export interface CapNotice {
  /** `warning` is "this send will stop part-way"; `note` is informational. */
  level: "warning" | "note";
  text: string;
}

/** Sentence-initial form of an allowance label. */
const capitalise = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What the confirmation dialog says about the caps, or `null` when there is
 * nothing to say (an uncapped instance, which is the self-hosted default).
 *
 * The warning names where the send stops and what happens next, because
 * "quota exceeded" on its own reads as "your campaign was lost". It was not:
 * the campaign pauses with its cursor intact and resumes from the exact
 * recipient it stopped at.
 */
export function capNotice(
  eligible: number,
  pre: CapPreflight,
): CapNotice | null {
  const { exceeded } = pre;
  if (exceeded)
    return {
      level: "warning",
      text:
        `This campaign has ${people(eligible)} in it and ${exceeded.label} ` +
        `has about ${formatCount(exceeded.remaining)} sends left ` +
        `(${formatCount(exceeded.used)} of ${formatCount(exceeded.limit)} used). ` +
        `Sending will stop after roughly ${formatCount(exceeded.remaining)} ` +
        `recipients and the remaining ${formatCount(pre.over)} will wait: the ` +
        `campaign pauses where it is and resumes by itself from the same ` +
        `recipient once the allowance renews` +
        (exceeded.renews ? ` (${exceeded.renews})` : "") +
        ` or the limit is raised. Half your list would get this today and the ` +
        `rest later.`,
    };
  const tightest = pre.allowances[0];
  if (!tightest) return null;
  return {
    level: "note",
    text:
      `${capitalise(tightest.label)} has ` +
      `${formatCount(tightest.remaining)} sends left; this campaign uses ` +
      `${formatCount(eligible)} of them.`,
  };
}

/* ------------------------------------------------------------------ *
 * What a status allows
 * ------------------------------------------------------------------ */

/**
 * What the page may offer for a campaign in each status.
 *
 * A **full** `Record`, like `LOCKED` in `CampaignEditor.tsx` and for the same
 * reason: the authority is `services/campaigns/crud.ts`, which a client
 * component cannot import, so a status added later must fail the typecheck
 * here rather than default to something. Defaulting to "can be sent" is the
 * failure that mails a list twice.
 *
 * `cancel` distinguishes the two transitions `cancelCampaign` implements,
 * because they are not the same act and must not share a dialog: un-arming a
 * `scheduled` campaign has sent nothing, and stopping a `sending` one cannot
 * take back what has already gone.
 */
export interface StatusPlan {
  /** May this campaign be armed — scheduled, or sent as soon as possible? */
  canArm: boolean;
  /** Which cancel applies, if any. */
  cancel: "unschedule" | "stop" | null;
  /** Are the numbers still moving? Drives the live refresh. */
  live: boolean;
  /** Should the stats come before the editor on the page? */
  statsFirst: boolean;
  /** One line saying where this campaign is. */
  summary: string;
}

export const STATUS_PLAN: Record<CampaignStatus, StatusPlan> = {
  draft: {
    canArm: true,
    cancel: null,
    live: false,
    statsFirst: false,
    summary:
      "Nothing has been sent. This campaign leaves only when you send or schedule it.",
  },
  scheduled: {
    canArm: true,
    cancel: "unschedule",
    live: false,
    statsFirst: false,
    summary:
      "Armed. The send starts on its own at the time below — nobody needs to be at a keyboard for it.",
  },
  sending: {
    canArm: false,
    cancel: "stop",
    live: true,
    statsFirst: true,
    summary:
      "Sending now. Recipients are queued in chunks, so these numbers are still moving.",
  },
  sent: {
    canArm: false,
    cancel: null,
    live: true,
    statsFirst: true,
    summary:
      "Every recipient has been queued. Deliveries, opens and clicks keep landing for hours afterwards.",
  },
  cancelled: {
    canArm: false,
    cancel: null,
    live: true,
    statsFirst: true,
    summary:
      "Cancelled part-way through. Further fan-out stopped; the mail already handed to SES still arrived, and its events are still landing below.",
  },
};

/**
 * Why this campaign cannot be sent right now, or `null` if it can.
 *
 * Every branch is a refusal the service would make anyway — this is the
 * explanation, not the enforcement. `campaigns.manage` is checked in
 * `crud.ts` before it looks anything up, and the status is re-asserted in the
 * `where` clause of the write.
 */
export function whyCannotSend(i: {
  status: CampaignStatus;
  canManage: boolean;
  eligible: number;
  /** `false` when the campaign's contact book has been deleted. */
  bookExists: boolean;
}): string | null {
  if (!i.canManage)
    return "Sending a campaign needs the admin role. Ask a team admin to send it.";
  if (!STATUS_PLAN[i.status].canArm)
    return `A campaign that is ${i.status} cannot be sent again.`;
  if (!i.bookExists)
    return "The contact book this campaign was drawn from has been deleted. Pick another book before sending.";
  if (i.eligible === 0)
    return "Nobody in this book can receive this campaign: everyone in it has either unsubscribed or been suppressed. Sending it would mail no one.";
  return null;
}

/* ------------------------------------------------------------------ *
 * The confirmation
 * ------------------------------------------------------------------ */

/**
 * Does what was typed name this campaign?
 *
 * Trimmed on both sides (a trailing space from a paste or a double-click is
 * not a different campaign) and otherwise exact, case included. A campaign
 * with a blank name never matches: `CreateCampaignInput` requires one, so a
 * blank here means something is wrong upstream, and the safe answer to "is
 * this confirmed?" when we cannot tell is no.
 */
export function confirmationMatches(typed: string, name: string): boolean {
  const want = name.trim();
  if (want === "") return false;
  return typed.trim() === want;
}

export interface SendFact {
  label: string;
  value: string;
}

export interface SendConfirmation {
  title: string;
  /** Campaign, book, recipients, when — the four things being committed to. */
  facts: SendFact[];
  /** The sentence that says there is no undo. */
  irreversible: string;
  /** The instruction above the confirmation field. */
  prompt: string;
  /** The button, which names the count again. */
  action: string;
}

/**
 * Every word of the send dialog.
 *
 * In the module rather than the JSX because these are the sentences somebody
 * reads immediately before mailing fifty thousand people, and a test can hold
 * them to naming the campaign, the book and the exact recipient count. A
 * dialog that says "Are you sure?" has told the customer nothing they did not
 * already know; this one has to tell them something they might not.
 *
 * "Queued", not "delivered", throughout — the send hands each message to SES
 * and SES decides the rest, which is the same distinction the stats panel
 * makes about `sent`.
 */
export function sendConfirmation(i: {
  name: string;
  /** `null` when the book has been deleted; the dialog says so. */
  bookName: string | null;
  audience: AudiencePreview;
  /** The chosen send time, or `null` for "as soon as possible". */
  scheduledAt: Date | null;
}): SendConfirmation {
  const n = i.audience.eligible;
  const when = i.scheduledAt
    ? `${formatWhen(i.scheduledAt)}, without anyone confirming again`
    : "within a minute of confirming";
  return {
    title: i.scheduledAt
      ? `Schedule "${i.name}" for ${people(n)}?`
      : `Send "${i.name}" to ${people(n)}?`,
    facts: [
      { label: "Campaign", value: i.name },
      {
        label: "Contact book",
        value: i.bookName
          ? `${i.bookName} — ${formatCount(i.audience.contacts)} contacts`
          : "Deleted — this campaign cannot be sent",
      },
      {
        label: "Recipients",
        value: `${people(n)} — everyone in the book who is subscribed and not suppressed`,
      },
      { label: "Starts", value: when },
    ],
    irreversible:
      "This cannot be undone. From the moment the first chunk is queued the " +
      "mail is on its way to SES, and there is no recall — not from this " +
      "page, not from support. Cancelling later stops the recipients who " +
      "have not been reached yet and nobody else.",
    prompt: `Type the campaign name — ${i.name} — to confirm.`,
    action: i.scheduledAt
      ? `Schedule for ${people(n)}`
      : `Send to ${people(n)}`,
  };
}

export interface CancelConfirmation {
  title: string;
  body: string;
  /** The button that goes through with it. */
  action: string;
  /** The button that does not. */
  dismiss: string;
}

/**
 * Every word of the cancel dialog, in its two genuinely different forms.
 *
 * The `stop` copy is the one that matters. Cancelling a `sending` campaign
 * stops **further fan-out** and nothing else: `cancelCampaign` deliberately
 * leaves `counts` standing, because the numbers are the evidence of what did
 * go out and they keep rising afterwards as events land for mail already in
 * flight. A dialog that let somebody believe "cancel" meant "recall" would be
 * a lie they discover from their own recipients, which is the worst place to
 * discover it.
 */
export function cancelConfirmation(i: {
  kind: "unschedule" | "stop";
  name: string;
  counts: Pick<CampaignCounts, "recipients" | "sent">;
}): CancelConfirmation {
  if (i.kind === "unschedule")
    return {
      title: `Unschedule "${i.name}"?`,
      body:
        "Nothing has been sent yet, so there is nothing to take back. The " +
        "campaign goes back to being a draft you can edit, and the send time " +
        "is cleared — schedule it again when you are ready.",
      action: "Unschedule",
      dismiss: "Keep the schedule",
    };
  return {
    title: `Stop sending "${i.name}"?`,
    body:
      `This stops the recipients who have not been reached yet. It cannot ` +
      `recall mail that has already been handed to SES: ` +
      `${people(i.counts.sent)} of ${people(i.counts.recipients)} queued so ` +
      `far have already been sent to, and those messages will still arrive. ` +
      `Their delivery, open and click numbers will keep rising here for a ` +
      `while afterwards — that is mail already in flight, not the campaign ` +
      `continuing. A stopped campaign cannot be restarted or edited; it is ` +
      `kept as the record of what went out.`,
    action: "Stop further sending",
    dismiss: "Keep sending",
  };
}

/* ------------------------------------------------------------------ *
 * The stats panel
 * ------------------------------------------------------------------ */

export interface StatDescriptor {
  key: keyof CampaignCounts;
  label: string;
  /** What this number counts, said in one line under it. */
  note: string;
  /** Denominator for a rate, or `null` when the number is not a rate. */
  rateOf: keyof CampaignCounts | null;
}

/**
 * The nine numbers, in reading order, each with the sentence that keeps it
 * from being misread.
 *
 * Two of those sentences are load-bearing, and both come from the stats work
 * rather than from taste:
 *
 * - **`sent` is not "delivered".** It counts recipients this campaign handed
 *   to SES — every one of them, once queueing finished. Labelling it
 *   "delivered" would overstate the outcome by the entire delivery window,
 *   and `delivered` is the row directly beneath it saying something different.
 * - **`opened` and `clicked` are per recipient, not per event.** Somebody who
 *   opens the same message six times is one opener, which is the only reading
 *   under which `opened / sent` is a rate rather than an arbitrary ratio. The
 *   raw event count is still on each message's own timeline.
 *
 * `unsubscribed` carries its own caveat: it attributes an opt-out to every
 * campaign that mailed that contact in the window before it, because no column
 * records which message an unsubscribe came from.
 */
export const CAMPAIGN_STATS: readonly StatDescriptor[] = [
  {
    key: "recipients",
    label: "Recipients",
    note: "People this campaign has selected and written a mail-log row for.",
    rateOf: null,
  },
  {
    key: "sent",
    label: "Queued to SES",
    note: "Handed to SES for delivery. Not the same as delivered — SES decides the rest.",
    rateOf: "recipients",
  },
  {
    key: "delivered",
    label: "Delivered",
    note: "SES confirmed the receiving server accepted the message.",
    rateOf: "sent",
  },
  {
    key: "opened",
    label: "Opened",
    note: "Recipients who opened it at least once — people, not opens. Mail clients under-report this.",
    rateOf: "sent",
  },
  {
    key: "clicked",
    label: "Clicked",
    note: "Recipients who clicked at least one tracked link — people, not clicks.",
    rateOf: "sent",
  },
  {
    key: "unsubscribed",
    label: "Unsubscribed",
    note: "Recipients who opted out after this campaign mailed them. Another campaign sent the same day claims them too.",
    rateOf: "sent",
  },
  {
    key: "bounced",
    label: "Bounced",
    note: "The address rejected it. Hard bounces are suppressed for every future send.",
    rateOf: "sent",
  },
  {
    key: "complained",
    label: "Complained",
    note: "Reported as spam. The address is suppressed. Above 0.1% your sending reputation is at risk.",
    rateOf: "sent",
  },
  {
    key: "failed",
    label: "Failed",
    note: "Never left: refused before SES accepted it. These recipients were not mailed.",
    rateOf: "recipients",
  },
];

/**
 * The mail log, filtered to this campaign.
 *
 * Every number links to the same place, deliberately: the mail-log status is a
 * monotone rank (`email-events.ts`), so a row that was delivered and later
 * complained about is now `complained` — a `status=delivered` link would show
 * fewer rows than the `delivered` number claims, and `opened`/`clicked` are
 * not statuses at all. A link that quietly disagrees with the number it sits
 * under is worse than one that opens the whole campaign and lets the log's own
 * filters do the narrowing.
 */
export const campaignLogHref = (campaignId: string): string =>
  `/app/emails?campaignId=${encodeURIComponent(campaignId)}`;
