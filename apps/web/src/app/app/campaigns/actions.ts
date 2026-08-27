"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import {
  can,
  type CampaignBlock,
  type CampaignStatus,
  type CampaignTheme,
} from "@sendsprite/shared";
import { requestMeta } from "@/lib/audit";
import type { Result } from "@/lib/result";
import { requireTeam } from "@/lib/session";
import * as campaigns from "@/services/campaigns/crud";
import { sendCampaignTest } from "@/services/test-send";
import { confirmationMatches } from "./send";

export type { Result } from "@/lib/result";

/**
 * Server actions for the campaign editor. Thin by design, exactly as
 * `templates/actions.ts` is: resolve the actor, delegate, revalidate.
 *
 * Nothing here validates. `CreateCampaignInput`/`UpdateCampaignInput` run
 * inside the service on the way to the database, and the block contract runs
 * again inside `renderBlocks` on the way to the inbox — a check added here
 * would be a third set of rules to keep in step, and the first one to drift.
 *
 * The CRUD actions check no permissions either, for the same reason:
 * `campaigns.*` in `services/campaigns/crud.ts` checks `campaigns.manage`
 * before it looks anything up, so a member who reaches these functions
 * directly (a server action is a POST endpoint, not a button) gets the same
 * refusal the UI shows.
 *
 * {@link armCampaign} is the one exception, and it is an exception in the
 * safe direction — see its own comment.
 */
async function actor() {
  const ctx = await requireTeam();
  return {
    userId: ctx.userId,
    teamId: ctx.team.id,
    teamName: ctx.team.name,
    role: ctx.role,
    meta: requestMeta(await headers()),
  };
}

/** What the editor sends. Every field is validated again by the service. */
export interface CampaignDraft {
  name: string;
  bookId: string;
  domainId: string;
  from: string;
  /** `""` means "no reply-to", which the two paths express differently. */
  replyTo: string;
  subject: string;
  blocks: CampaignBlock[];
  /** `{}` renders the defaults, which is what an absent theme has always done. */
  theme: CampaignTheme;
  /** Merge-field fallbacks by placeholder name; `{}` is none. */
  mergeDefaults: Record<string, string>;
  /** Linked header/footer layout ids; `""` is "no layout". */
  headerLayoutId: string;
  footerLayoutId: string;
}

/** Whether the draft carries any merge-field fallback at all. */
const hasMergeDefaults = (d: CampaignDraft) =>
  Object.keys(d.mergeDefaults).length > 0;

export async function createCampaign(
  draft: CampaignDraft,
): Promise<Result<{ id: string }>> {
  const res = await campaigns.createCampaign(await actor(), {
    ...draft,
    // Omitted rather than null: `CreateCampaignInput.replyTo` is `.optional()`,
    // and a null would be a validation error rather than "there isn't one".
    replyTo: draft.replyTo.trim() ? draft.replyTo : undefined,
    // Empty is "no fallbacks", which the create path expresses by omission.
    mergeDefaults: hasMergeDefaults(draft) ? draft.mergeDefaults : undefined,
    // `""` (the select's "None") is not a valid id — omit it on create.
    headerLayoutId: draft.headerLayoutId || undefined,
    footerLayoutId: draft.footerLayoutId || undefined,
  });
  if (!res.ok) return res;
  revalidatePath("/app/campaigns");
  return { ok: true, data: { id: res.data.id } };
}

export async function updateCampaign(
  id: string,
  draft: CampaignDraft,
): Promise<Result<{ status: CampaignStatus }>> {
  const res = await campaigns.updateCampaign(await actor(), id, {
    ...draft,
    // `null`, not `undefined`: on the update path clearing the field has to be
    // expressible, and `undefined` there means "leave it alone".
    replyTo: draft.replyTo.trim() ? draft.replyTo : null,
    // `null` (not `{}`) when empty, so a campaign that sets no fallbacks
    // compares equal to a null column and its schedule is not reverted by a
    // no-op save. See `changedFields` in services/campaigns/crud.ts.
    mergeDefaults: hasMergeDefaults(draft) ? draft.mergeDefaults : null,
    // `""` (None) clears the slot, which on the update path is `null`.
    headerLayoutId: draft.headerLayoutId || null,
    footerLayoutId: draft.footerLayoutId || null,
  });
  if (!res.ok) return res;
  revalidatePath(`/app/campaigns/${id}`);
  revalidatePath("/app/campaigns");
  // Read back off the row: saving an edit to a *scheduled* campaign reverts it
  // to `draft` and drops its send time, and the header has to say so.
  return { ok: true, data: { status: res.data.status } };
}

export async function deleteCampaign(id: string): Promise<Result> {
  const res = await campaigns.deleteCampaign(await actor(), id);
  if (res.ok) revalidatePath("/app/campaigns");
  return res;
}

/**
 * What arming a campaign returns, so the page can update without a reload.
 * `scheduledAt` is an ISO string because a `Date` crossing the server-action
 * boundary is fine but a string is what the UI formats anyway.
 */
export interface ArmedCampaign {
  status: CampaignStatus;
  scheduledAt: string | null;
}

const NOT_CONFIRMED: Result<never> = {
  ok: false,
  code: "validation_error",
  error:
    "Type the campaign's name exactly to confirm the send. Nothing was sent.",
};

/**
 * Arm a campaign: schedule it, or — with no time — send it as soon as the
 * sweep next runs.
 *
 * Both go through `scheduleCampaign`, which is the only supported way into
 * `scheduled`; the `campaign.start-sweep` is the only thing that moves a
 * campaign to `sending`, because starting renders the body once and stamps
 * `started_at` and a second start path would race the sweep.
 *
 * ## Why the typed confirmation is re-checked here
 *
 * The Next.js docs are explicit that a Server Function is reachable by a
 * direct POST regardless of what the UI renders, so a dialog that disables its
 * own button is friction for the person who opened the dialog and no friction
 * at all for anything else — a stray `fetch`, a replayed request, a second
 * click that got through before the first navigated. This is the single most
 * expensive action in the product, so the same string the dialog asks for is
 * required as an argument and compared against the stored campaign name
 * **here**, where it cannot be skipped.
 *
 * It is not a security control and it is not pretending to be one:
 * `campaigns.manage` is the authorization, and it is enforced inside
 * `scheduleCampaign` before that function looks anything up. The permission is
 * checked once more at the top of this action purely so that the name lookup
 * below cannot become an existence oracle for a member who is not allowed to
 * send: without it, a read-only member could learn which campaign ids are real
 * by watching "not found" turn into "type the name to confirm".
 */
export async function armCampaign(
  id: string,
  input: { scheduledAt: string | null; confirmation: string },
): Promise<Result<ArmedCampaign>> {
  const a = await actor();
  if (!can(a.role, "campaigns.manage"))
    return {
      ok: false,
      code: "forbidden",
      error: "You don't have permission to do that.",
    };
  const current = await campaigns.getCampaign(a.teamId, id);
  if (!current)
    return { ok: false, code: "not_found", error: "Campaign not found." };
  if (!confirmationMatches(input.confirmation, current.name))
    return NOT_CONFIRMED;
  const res = await campaigns.scheduleCampaign(
    a,
    id,
    // Omitted rather than null: `ScheduleCampaignInput.scheduledAt` is
    // `.optional()`, and an absent time means "due now" — a null would be a
    // validation error instead.
    input.scheduledAt ? { scheduledAt: input.scheduledAt } : {},
  );
  if (!res.ok) return res;
  revalidatePath(`/app/campaigns/${id}`);
  revalidatePath("/app/campaigns");
  return {
    ok: true,
    data: {
      status: res.data.status,
      scheduledAt: res.data.scheduledAt?.toISOString() ?? null,
    },
  };
}

/**
 * Un-arm a `scheduled` campaign, or stop a `sending` one.
 *
 * No typed confirmation, deliberately. Cancelling is the direction that stops
 * mail rather than starting it, and the one moment somebody needs it most is
 * the moment they have just realised a send is wrong — friction there costs
 * recipients. The dialog still has to be honest about what stopping cannot do,
 * which is the copy's job (`cancelConfirmation` in `send.ts`), not this
 * function's.
 */
export async function cancelCampaign(
  id: string,
): Promise<Result<{ status: CampaignStatus }>> {
  const res = await campaigns.cancelCampaign(await actor(), id);
  if (!res.ok) return res;
  revalidatePath(`/app/campaigns/${id}`);
  revalidatePath("/app/campaigns");
  return { ok: true, data: { status: res.data.status } };
}

/**
 * Sends one copy of the campaign currently in the editor.
 *
 * It takes the draft rather than a campaign id on purpose: the point of a test
 * is to look at what you are working on, and requiring a save first would make
 * "check this before I commit it" impossible for a campaign that is already
 * scheduled — saving one reverts it to a draft and drops its send time.
 *
 * Permission is `campaigns.manage`, the same as editing: a test send is a
 * send, and the role that may not change the body may not put it in an inbox
 * either.
 */
export async function sendCampaignTestAction(
  draft: Pick<
    CampaignDraft,
    "from" | "replyTo" | "subject" | "blocks" | "theme"
  >,
  to: string[],
): Promise<Result<{ emailId: string }>> {
  const a = await actor();
  if (!can(a.role, "campaigns.manage"))
    return { ok: false, error: "You don't have permission to do that." };
  const res = await sendCampaignTest(
    { teamId: a.teamId, userId: a.userId },
    {
      to,
      from: draft.from,
      replyTo: draft.replyTo.trim() === "" ? undefined : draft.replyTo,
      subject: draft.subject,
      blocks: draft.blocks,
      theme: draft.theme,
    },
  );
  if (res.ok) revalidatePath("/app/emails");
  return res.ok ? { ok: true, data: { emailId: res.data.emailId } } : res;
}
