import { describe, expect, it } from "vitest";
import { CAMPAIGN_STATUSES, type AudiencePreview } from "@sendsprite/shared";
import {
  CAMPAIGN_STATS,
  STATUS_PLAN,
  audienceBreakdown,
  campaignLogHref,
  cancelConfirmation,
  capNotice,
  capPreflight,
  confirmationMatches,
  formatCount,
  people,
  rate,
  sendConfirmation,
  whyCannotSend,
  type TeamAllowance,
} from "@/app/app/campaigns/send";

const audience = (p: Partial<AudiencePreview> = {}): AudiencePreview => ({
  contacts: 0,
  subscribed: 0,
  suppressed: 0,
  eligible: 0,
  ...p,
});

const allowance = (p: Partial<TeamAllowance> = {}): TeamAllowance => ({
  dailyLimit: null,
  dailyUsed: 0,
  monthlyLimit: null,
  monthlyUsed: 0,
  monthlyUntil: new Date("2026-09-01T00:00:00.000Z"),
  accountQuota: null,
  accountUsed: 0,
  ...p,
});

/* ------------------------------------------------------------------ *
 * The audience
 * ------------------------------------------------------------------ */

describe("audienceBreakdown", () => {
  /**
   * The whole reason this function exists. The four counts are four views of
   * one population — `eligible` is a subset of `subscribed`, and `suppressed`
   * overlaps both — so the only number the card can honestly call "excluded"
   * is `contacts - eligible`.
   */
  it("derives excluded as contacts minus eligible, not the sum of the reasons", () => {
    // 1 000 contacts: 40 unsubscribed, 30 suppressed, 10 of them both.
    // Excluded is 60, not 70.
    const a = audienceBreakdown(
      audience({
        contacts: 1000,
        subscribed: 960,
        suppressed: 30,
        eligible: 940,
      }),
    );
    expect(a.unsubscribed).toBe(40);
    expect(a.excluded).toBe(60);
    expect(a.both).toBe(10);
    // And the honest sum does add up: the two reasons minus their overlap.
    expect(a.unsubscribed + a.suppressed - a.both).toBe(a.excluded);
  });

  it("reports no overlap when the two exclusions are disjoint", () => {
    const a = audienceBreakdown(
      audience({ contacts: 100, subscribed: 90, suppressed: 5, eligible: 85 }),
    );
    expect(a.excluded).toBe(15);
    expect(a.both).toBe(0);
  });

  it("reports a total overlap when every suppressed contact also unsubscribed", () => {
    // 20 unsubscribed, all 20 also suppressed: 80 eligible, 20 excluded.
    const a = audienceBreakdown(
      audience({ contacts: 100, subscribed: 80, suppressed: 20, eligible: 80 }),
    );
    expect(a.excluded).toBe(20);
    expect(a.both).toBe(20);
  });

  it("counts a suppressed contact who still consents as excluded", () => {
    const a = audienceBreakdown(
      audience({ contacts: 10, subscribed: 10, suppressed: 3, eligible: 7 }),
    );
    expect(a.unsubscribed).toBe(0);
    expect(a.excluded).toBe(3);
    expect(a.both).toBe(0);
  });

  it("is all zeros for an empty book", () => {
    const a = audienceBreakdown(audience());
    expect([a.excluded, a.both, a.unsubscribed]).toEqual([0, 0, 0]);
  });

  /**
   * The counts come from one aggregate and cannot disagree today. A clamp
   * costs nothing and means a future query that does disagree renders a
   * slightly wrong card rather than "-3 people excluded".
   */
  it("never derives a negative number from inconsistent input", () => {
    const a = audienceBreakdown(
      audience({ contacts: 5, subscribed: 9, suppressed: 0, eligible: 9 }),
    );
    expect(a.unsubscribed).toBe(0);
    expect(a.excluded).toBe(0);
    expect(a.both).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The pre-flight cap check
 * ------------------------------------------------------------------ */

describe("capPreflight", () => {
  it("finds nothing to measure on an uncapped instance", () => {
    const pre = capPreflight(50_000, allowance());
    expect(pre.allowances).toEqual([]);
    expect(pre.exceeded).toBeNull();
    expect(capNotice(50_000, pre)).toBeNull();
  });

  it("passes a send that fits inside the monthly allowance", () => {
    const pre = capPreflight(
      1_000,
      allowance({ monthlyLimit: 50_000, monthlyUsed: 10_000 }),
    );
    expect(pre.exceeded).toBeNull();
    expect(pre.over).toBe(0);
    expect(pre.allowances[0]?.remaining).toBe(40_000);
    expect(capNotice(1_000, pre)?.level).toBe("note");
  });

  /** The case this whole pre-flight exists for. */
  it("catches a campaign larger than what is left of the monthly allowance", () => {
    const pre = capPreflight(
      50_000,
      allowance({ monthlyLimit: 30_000, monthlyUsed: 17_600 }),
    );
    expect(pre.exceeded?.kind).toBe("monthly");
    expect(pre.exceeded?.remaining).toBe(12_400);
    expect(pre.over).toBe(37_600);
    const notice = capNotice(50_000, pre);
    expect(notice?.level).toBe("warning");
    // The numbers a customer needs are all in the sentence: how many fit, how
    // many wait, and that the campaign resumes rather than being lost.
    expect(notice?.text).toContain("12,400");
    expect(notice?.text).toContain("37,600");
    expect(notice?.text).toContain("resumes by itself");
  });

  it("reports the tightest cap when several would refuse", () => {
    const pre = capPreflight(
      5_000,
      allowance({
        dailyLimit: 1_000,
        dailyUsed: 900,
        monthlyLimit: 20_000,
        monthlyUsed: 0,
      }),
    );
    expect(pre.exceeded?.kind).toBe("daily");
    expect(pre.exceeded?.remaining).toBe(100);
  });

  it("clamps a remaining allowance that has already been overshot", () => {
    // The caps are soft: check-then-insert can overshoot. "-50 left" is not a
    // number to show anybody.
    const pre = capPreflight(
      10,
      allowance({ monthlyLimit: 1_000, monthlyUsed: 1_050 }),
    );
    expect(pre.exceeded?.remaining).toBe(0);
    expect(pre.over).toBe(10);
  });

  /**
   * `usageSnapshot` skips the instance-wide scan whenever the team has a cap
   * of its own and reports `accountUsed: 0`. Believing that would print a
   * confidently wrong "0 of 50 000 used" on a busy instance.
   */
  /**
   * The account quota used to be dropped whenever a team cap was set, because
   * the snapshot reported 0 for it in that case. Scoped to the team it is
   * always measured, so it is always shown — and it can be the binding one
   * even when a roomier team cap exists.
   */
  it("always reports the account quota, alongside a team cap", () => {
    const pre = capPreflight(
      100,
      allowance({
        monthlyLimit: 10_000,
        monthlyUsed: 0,
        accountQuota: 50,
        accountUsed: 0,
      }),
    );
    expect(pre.allowances.map((a) => a.kind).sort()).toEqual([
      "account",
      "monthly",
    ]);
    // 100 eligible against 50 left on the AWS account.
    expect(pre.exceeded?.kind).toBe("account");
    expect(pre.exceeded?.remaining).toBe(50);
  });

  it("uses the account quota when it is the only limit", () => {
    const pre = capPreflight(
      100,
      allowance({ accountQuota: 120, accountUsed: 90 }),
    );
    expect(pre.exceeded?.kind).toBe("account");
    expect(pre.exceeded?.remaining).toBe(30);
  });

  it("names when the monthly allowance renews", () => {
    const pre = capPreflight(
      10,
      allowance({ monthlyLimit: 5, monthlyUsed: 0 }),
    );
    expect(capNotice(10, pre)?.text).toContain("Sep 1");
  });
});

/* ------------------------------------------------------------------ *
 * What a status allows
 * ------------------------------------------------------------------ */

describe("STATUS_PLAN", () => {
  it("covers every campaign status", () => {
    for (const s of CAMPAIGN_STATUSES) expect(STATUS_PLAN[s]).toBeDefined();
    expect(Object.keys(STATUS_PLAN).sort()).toEqual(
      [...CAMPAIGN_STATUSES].sort(),
    );
  });

  /**
   * The service is the authority (`EDITABLE_STATUSES` in `crud.ts`): only
   * `draft` and `scheduled` can be armed, and only `scheduled` and `sending`
   * can be cancelled. A page that offered either anywhere else would put a
   * button in front of a refusal.
   */
  it("arms only what the service will arm", () => {
    expect(CAMPAIGN_STATUSES.filter((s) => STATUS_PLAN[s].canArm)).toEqual([
      "draft",
      "scheduled",
    ]);
  });

  it("offers the two cancels the service implements, and no other", () => {
    expect(STATUS_PLAN.scheduled.cancel).toBe("unschedule");
    expect(STATUS_PLAN.sending.cancel).toBe("stop");
    expect(STATUS_PLAN.draft.cancel).toBeNull();
    expect(STATUS_PLAN.sent.cancel).toBeNull();
    expect(STATUS_PLAN.cancelled.cancel).toBeNull();
  });

  /**
   * A cancelled campaign keeps refreshing: `cancelCampaign` leaves `counts`
   * standing and events keep landing for mail that was already in flight.
   */
  it("keeps watching every status whose numbers can still move", () => {
    expect(CAMPAIGN_STATUSES.filter((s) => STATUS_PLAN[s].live)).toEqual([
      "sending",
      "sent",
      "cancelled",
    ]);
  });
});

describe("whyCannotSend", () => {
  const base = {
    status: "draft" as const,
    canManage: true,
    eligible: 10,
    bookExists: true,
  };

  it("allows a draft with an audience and the permission", () => {
    expect(whyCannotSend(base)).toBeNull();
  });

  it("refuses a member without campaigns.manage", () => {
    expect(whyCannotSend({ ...base, canManage: false })).toContain("admin");
  });

  it("refuses every status past scheduled", () => {
    for (const status of ["sending", "sent", "cancelled"] as const)
      expect(whyCannotSend({ ...base, status })).toContain(status);
  });

  it("refuses a campaign whose book has been deleted", () => {
    expect(whyCannotSend({ ...base, bookExists: false })).toContain("deleted");
  });

  /** Sending to nobody is not a send; it is a mistake with a progress bar. */
  it("refuses an audience of nobody", () => {
    expect(whyCannotSend({ ...base, eligible: 0 })).toContain("no one");
  });

  it("reports the permission before anything else", () => {
    expect(whyCannotSend({ ...base, canManage: false, eligible: 0 })).toContain(
      "admin",
    );
  });
});

/* ------------------------------------------------------------------ *
 * The confirmation
 * ------------------------------------------------------------------ */

describe("confirmationMatches", () => {
  it("accepts the exact name", () => {
    expect(confirmationMatches("August newsletter", "August newsletter")).toBe(
      true,
    );
  });

  it("accepts surrounding whitespace from a paste", () => {
    expect(
      confirmationMatches("  August newsletter ", "August newsletter"),
    ).toBe(true);
  });

  it("refuses a different case", () => {
    expect(confirmationMatches("august newsletter", "August newsletter")).toBe(
      false,
    );
  });

  it("refuses a prefix, a suffix and an empty box", () => {
    expect(confirmationMatches("August", "August newsletter")).toBe(false);
    expect(confirmationMatches("August newsletter!", "August newsletter")).toBe(
      false,
    );
    expect(confirmationMatches("", "August newsletter")).toBe(false);
  });

  /**
   * Fail closed. A campaign cannot have a blank name (`CreateCampaignInput`
   * requires one), so a blank here means something is wrong upstream — and the
   * safe answer to "is this confirmed?" when we cannot tell is no. Without
   * this, an empty box would confirm an empty name.
   */
  it("never matches a blank campaign name", () => {
    expect(confirmationMatches("", "")).toBe(false);
    expect(confirmationMatches("  ", "   ")).toBe(false);
  });
});

describe("sendConfirmation", () => {
  const copy = sendConfirmation({
    name: "August newsletter",
    bookName: "Subscribers",
    audience: audience({
      contacts: 1000,
      subscribed: 960,
      suppressed: 30,
      eligible: 940,
    }),
    scheduledAt: null,
  });

  /** Not "Are you sure?" — the three facts being committed to, by name. */
  it("names the campaign, the book and the exact recipient count", () => {
    expect(copy.title).toContain("August newsletter");
    expect(copy.title).toContain("940 people");
    const values = copy.facts.map((f) => `${f.label}: ${f.value}`).join("\n");
    expect(values).toContain("Campaign: August newsletter");
    expect(values).toContain("Subscribers");
    expect(values).toContain("1,000 contacts");
    expect(values).toContain("940 people");
    expect(copy.action).toContain("940 people");
  });

  it("says there is no undo, in those terms", () => {
    expect(copy.irreversible).toContain("cannot be undone");
    expect(copy.irreversible).toContain("no recall");
  });

  it("asks for the campaign name by name", () => {
    expect(copy.prompt).toContain("August newsletter");
  });

  it("says when a send with no time starts", () => {
    expect(copy.facts.find((f) => f.label === "Starts")?.value).toContain(
      "within a minute",
    );
  });

  it("names the time, and the lack of a second confirmation, when scheduled", () => {
    const later = sendConfirmation({
      name: "August newsletter",
      bookName: "Subscribers",
      audience: audience({ contacts: 1, subscribed: 1, eligible: 1 }),
      scheduledAt: new Date("2026-09-02T09:30:00.000Z"),
    });
    expect(later.title).toContain("Schedule");
    const starts = later.facts.find((f) => f.label === "Starts")?.value ?? "";
    expect(starts).toContain("Sep 2");
    expect(starts).toContain("without anyone confirming again");
    // One recipient is a person, not "1 people".
    expect(later.title).toContain("1 person");
  });

  it("says so when the book has been deleted", () => {
    const gone = sendConfirmation({
      name: "August newsletter",
      bookName: null,
      audience: audience(),
      scheduledAt: null,
    });
    expect(gone.facts.find((f) => f.label === "Contact book")?.value).toContain(
      "Deleted",
    );
  });
});

describe("cancelConfirmation", () => {
  const counts = { recipients: 50_000, sent: 12_000 };

  /**
   * The honesty test, in copy form. Cancelling a sending campaign stops
   * further fan-out and cannot recall what has left; a dialog that let
   * somebody believe otherwise would be a lie they discover from their own
   * recipients.
   */
  it("says what stopping a send cannot do, and names what already went", () => {
    const copy = cancelConfirmation({
      kind: "stop",
      name: "August newsletter",
      counts,
    });
    expect(copy.title).toContain("August newsletter");
    expect(copy.body).toContain("cannot recall");
    expect(copy.body).toContain("12,000 people");
    expect(copy.body).toContain("50,000 people");
    expect(copy.body).toContain("will still arrive");
    // And that the numbers going up afterwards is not the campaign continuing.
    expect(copy.body).toContain("keep rising");
    expect(copy.action).toBe("Stop further sending");
    expect(copy.dismiss).toBe("Keep sending");
  });

  it("says nothing has been sent when un-arming a schedule", () => {
    const copy = cancelConfirmation({
      kind: "unschedule",
      name: "August newsletter",
      counts: { recipients: 0, sent: 0 },
    });
    expect(copy.body).toContain("Nothing has been sent");
    expect(copy.body).toContain("draft");
    expect(copy.action).toBe("Unschedule");
  });
});

/* ------------------------------------------------------------------ *
 * The stats panel
 * ------------------------------------------------------------------ */

describe("CAMPAIGN_STATS", () => {
  const byKey = new Map(CAMPAIGN_STATS.map((s) => [s.key, s]));

  it("covers all nine counts once", () => {
    expect(CAMPAIGN_STATS).toHaveLength(9);
    expect(byKey.size).toBe(9);
  });

  /**
   * `campaign.sent` means every recipient was **queued**, not delivered — the
   * webhook docs say so in those words, and `delivered` is the row beneath it
   * saying something different.
   */
  it("never labels the queued count 'delivered'", () => {
    const sent = byKey.get("sent");
    expect(sent?.label).toBe("Queued to SES");
    expect(sent?.label.toLowerCase()).not.toContain("delivered");
    expect(sent?.note).toContain("Not the same as delivered");
  });

  /** Opens are per recipient, which is what makes `opened / sent` a rate. */
  it("says opens and clicks count people rather than events", () => {
    expect(byKey.get("opened")?.note).toContain("people, not opens");
    expect(byKey.get("clicked")?.note).toContain("people, not clicks");
    expect(byKey.get("opened")?.rateOf).toBe("sent");
  });

  it("rates the outcome counts against what was queued, not against the book", () => {
    for (const k of [
      "delivered",
      "opened",
      "clicked",
      "bounced",
      "complained",
    ] as const)
      expect(byKey.get(k)?.rateOf).toBe("sent");
    // `failed` never left, so it is measured against recipients instead.
    expect(byKey.get("failed")?.rateOf).toBe("recipients");
    expect(byKey.get("recipients")?.rateOf).toBeNull();
  });
});

describe("rate", () => {
  it("has no rate without a denominator", () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(5, 0)).toBeNull();
  });

  it("keeps a decimal where a decimal is the difference", () => {
    // 0.4 % complaints is a bad day; 0 % is a different fact entirely.
    expect(rate(4, 1000)).toBe("0.4%");
    expect(rate(632, 1000)).toBe("63%");
  });
});

describe("campaignLogHref", () => {
  it("filters the mail log by the campaign", () => {
    expect(campaignLogHref("cmp_123")).toBe("/app/emails?campaignId=cmp_123");
  });

  it("escapes an id that would otherwise inject a second parameter", () => {
    expect(campaignLogHref("a&status=sent")).toBe(
      "/app/emails?campaignId=a%26status%3Dsent",
    );
  });
});

describe("formatting", () => {
  it("groups digits", () => {
    expect(formatCount(50_000)).toBe("50,000");
  });

  it("counts people as people", () => {
    expect(people(1)).toBe("1 person");
    expect(people(0)).toBe("0 people");
    expect(people(940)).toBe("940 people");
  });
});
