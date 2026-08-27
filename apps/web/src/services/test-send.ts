import {
  UNSUBSCRIBE_MARKER,
  escapeHtml,
  renderBlocks,
  type CampaignBlock,
  type CampaignTheme,
} from "@sendsprite/shared";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { domains } from "@/db/schema";
import { enqueue } from "@/jobs/enqueue";
import { domainOf, parseAddress } from "@/lib/email-address";
import type { Result } from "@/lib/result";
import { createEmail } from "./emails";

/**
 * Sending one copy of something to yourself before it goes to everybody.
 *
 * There was no way to do this at all: the only way to see a campaign in a real
 * client was to send it to the contact book, and the only way to see a
 * template was to write a `POST /emails` by hand. For a product whose whole
 * job is email, that is the missing feature, not a nicety — a preview iframe
 * cannot tell you that Outlook collapses your button or that the subject is
 * truncated on a phone.
 *
 * It goes through {@link createEmail} like every other send, deliberately.
 * A second path that skipped suppressions, caps, tracking or the domain check
 * would be a test that does not test the thing being tested, and it would be
 * the path that quietly keeps working after the real one breaks. The only
 * differences are what they have to be:
 *
 * - **The unsubscribe marker is replaced with a dead link.** It is a control
 *   character the fan-out substitutes per recipient, and a test send has no
 *   recipient row to unsubscribe. Leaving it would put U+0001 in the message;
 *   dropping the footer entirely would hide the one element most likely to be
 *   wrong.
 * - **The subject is prefixed.** A test that looks identical to the real thing
 *   in an inbox is how a test send gets forwarded to a customer.
 *
 * It is *not* free: a test send is a real SES send, counts against the team's
 * caps and quota, and appears in the mail log. That is correct — it is a real
 * email — and the UI says so.
 */

export const TEST_SUBJECT_PREFIX = "[Test] ";

/** Recipients per test send. Enough for a spread of clients, not a broadcast. */
export const MAX_TEST_RECIPIENTS = 5;

const DEAD_UNSUBSCRIBE = "#";

export interface TestSendContext {
  teamId: string;
  userId: string;
}

/**
 * Substitutes the per-recipient unsubscribe marker with an inert link.
 *
 * `replaceAll` with a function, matching `fanout.ts`: a plain string
 * replacement would interpret `$&` and friends inside the replacement, and
 * while neither of these two contain one, the habit is what stops the next one
 * from doing so.
 */
function deadenUnsubscribe(html: string, text: string) {
  const footer = `<a href="${escapeHtml(DEAD_UNSUBSCRIBE)}">Unsubscribe (inert in a test send)</a>`;
  return {
    html: html.replaceAll(UNSUBSCRIBE_MARKER, () => footer),
    text: text.replaceAll(
      UNSUBSCRIBE_MARKER,
      () => "Unsubscribe: (inert in a test send)",
    ),
  };
}

/** Every recipient must parse, and there must be at least one. */
function recipients(raw: string[]): Result<string[]> {
  const list = raw.map((s) => s.trim()).filter(Boolean);
  if (list.length === 0)
    return {
      ok: false,
      error: "Add at least one address to send the test to.",
    };
  if (list.length > MAX_TEST_RECIPIENTS)
    return {
      ok: false,
      error: `At most ${MAX_TEST_RECIPIENTS} addresses per test send.`,
    };
  const bad = list.find((s) => parseAddress(s) === null);
  if (bad) return { ok: false, error: `"${bad}" is not a valid address.` };
  return { ok: true, data: list };
}

/**
 * Checks the from address belongs to a verified domain of this team.
 *
 * `createEmail` resolves the domain itself and would refuse an unverified one,
 * so this is about the *message*: its refusal is written for an API client and
 * names the domain, while somebody in the editor needs to be told which of the
 * two fields on screen is wrong.
 */
async function checkFrom(teamId: string, from: string): Promise<Result> {
  const parsed = parseAddress(from);
  if (!parsed)
    return { ok: false, error: "The From address is not a valid address." };
  const name = domainOf(parsed.email);
  if (!name) return { ok: false, error: "The From address has no domain." };
  const [row] = await db()
    .select({ status: domains.status })
    .from(domains)
    .where(and(eq(domains.teamId, teamId), eq(domains.name, name)))
    .limit(1);
  if (!row)
    return {
      ok: false,
      error: `${name} is not one of this team's sending domains. Add it under Domains first.`,
    };
  if (row.status !== "verified")
    return {
      ok: false,
      error: `${name} is not verified yet, so nothing can be sent from it.`,
    };
  return { ok: true, data: undefined };
}

export interface TestSendResult {
  emailId: string;
  to: string[];
}

/** A campaign body, rendered exactly as the fan-out would render it. */
export async function sendCampaignTest(
  ctx: TestSendContext,
  input: {
    to: string[];
    from: string;
    replyTo?: string;
    subject: string;
    blocks: CampaignBlock[];
    theme?: CampaignTheme;
  },
): Promise<Result<TestSendResult>> {
  const to = recipients(input.to);
  if (!to.ok) return to;
  const fromOk = await checkFrom(ctx.teamId, input.from);
  if (!fromOk.ok) return fromOk;
  if (input.subject.trim() === "")
    return { ok: false, error: "Give the campaign a subject first." };

  let rendered;
  try {
    // The same call the send makes. A body that fails the contract fails here
    // too, which is the point: a test send that renders something the real
    // send would refuse is worse than no test send.
    rendered = renderBlocks(input.blocks, { theme: input.theme });
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error
          ? `This body cannot be rendered: ${e.message}`
          : "This body cannot be rendered.",
    };
  }
  const body = deadenUnsubscribe(rendered.html, rendered.text);

  return dispatch(ctx, {
    to: to.data,
    from: input.from,
    replyTo: input.replyTo,
    subject: input.subject,
    html: body.html,
    text: body.text,
  });
}

/** A template, rendered through the same seam `POST /emails` uses. */
export async function sendTemplateTest(
  ctx: TestSendContext,
  input: {
    to: string[];
    from: string;
    slug: string;
    variables: Record<string, unknown>;
  },
): Promise<Result<TestSendResult>> {
  const to = recipients(input.to);
  if (!to.ok) return to;
  const fromOk = await checkFrom(ctx.teamId, input.from);
  if (!fromOk.ok) return fromOk;

  // `template` rather than a pre-rendered body: `createEmail` reads the row,
  // renders it and records the template id against the email, so the mail log
  // says which version of which template this was. Rendering here and passing
  // html would produce an email with no provenance at all.
  return dispatch(ctx, {
    to: to.data,
    from: input.from,
    subject: undefined,
    template: input.slug,
    variables: input.variables,
  });
}

async function dispatch(
  ctx: TestSendContext,
  input: Record<string, unknown> & { subject?: string },
): Promise<Result<TestSendResult>> {
  const res = await createEmail(
    {
      teamId: ctx.teamId,
      source: "dashboard",
      apiKeyId: null,
      actorUserId: ctx.userId,
    },
    {
      ...input,
      // Prefixed after validation so the prefix cannot push a legitimate
      // subject over the contract's limit and blame the author for it.
      ...(input.subject !== undefined
        ? { subject: `${TEST_SUBJECT_PREFIX}${input.subject}`.slice(0, 998) }
        : {}),
      // Tags rather than a header: they are indexed and filterable in the mail
      // log, so "show me what went out for real" is a query rather than a
      // reading exercise.
      tags: { sendsprite_test: "true" },
    },
    { enqueue },
  );
  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    data: { emailId: res.data.id, to: input.to as string[] },
  };
}
