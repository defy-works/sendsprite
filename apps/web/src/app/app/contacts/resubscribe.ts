/**
 * The wording of the resubscribe speed bump, kept out of the panel so it can
 * be read and tested on its own.
 *
 * Unsubscribing needs no confirmation — it is the safe direction. Putting
 * somebody *back* is the one contact mutation this dashboard offers that can
 * only be justified by something that happened outside it: a reply, a support
 * ticket, a form they filled in. The service allows it (`updateContact` with
 * `subscribed: true` clears `unsubscribed_at` and the reason), and it should:
 * an operator acting on a request they received is exactly the legitimate
 * case. What it cannot know is whether such a request exists, and one
 * unlabelled click between "this person opted out" and "this person is on the
 * list again" is how a team ends up mailing someone who asked them not to.
 *
 * So this is a UI speed bump and nothing more. **No new service rule** —
 * a rule the API does not share would be a rule that is not enforced, just
 * relocated. What the dialog owes the operator is the two facts they need to
 * decide: when the person left, and what the record says about *who* did it.
 * The reasons below are the ones this codebase actually writes; anything else
 * came from a caller and is quoted rather than paraphrased.
 */

/** Written by `updateContact` from this dashboard (`setSubscribed`). */
const MANUAL = "manual";
/** `POST /api/v1/contacts/unsubscribe`'s default when the caller sends none. */
const API = "api";
/** A CSV row that arrived with `subscribed=false` and no reason of its own. */
const IMPORT = "import";

/**
 * How each recorded reason reads to somebody deciding whether to undo it.
 *
 * `api` is the one that carries a warning, because it is the reason an
 * unsubscribe *link* leaves behind: a public unsubscribe endpoint is a
 * customer's own handler calling `POST /contacts/unsubscribe`, and the
 * default reason it writes is this one. A row that says `api` is therefore
 * more likely to be the person's own decision than the operator's, and the
 * dialog says so instead of presenting all three the same way.
 */
function reasonLine(reason: string | null): string {
  switch (reason) {
    case MANUAL:
      return 'The record says "manual": somebody on this team unsubscribed them from this dashboard or the API.';
    case API:
      return 'The record says "api": this came through the unsubscribe endpoint, which is the path an unsubscribe link takes — so it was most likely the person\'s own request, not a mistake to undo.';
    case IMPORT:
      return 'The record says "import": they arrived already unsubscribed in a CSV, so the consent decision was made wherever that list came from.';
    case null:
    case "":
      return "No reason was recorded, so there is nothing here that says they asked to come back.";
    default:
      return `The record says "${reason}".`;
  }
}

/** Title and body, so the dialog can typeset them rather than print a blob. */
export interface ResubscribeCopy {
  title: string;
  body: string;
}

export interface ResubscribePrompt {
  email: string;
  /** `unsubscribe_reason` exactly as stored. */
  reason: string | null;
  /** `unsubscribed_at`, already formatted by the server (`formatWhen`). */
  unsubscribedWhen: string;
}

/**
 * The text of the confirmation shown before a contact is resubscribed.
 *
 * It names the address, the date and the reason, and it closes by saying what
 * resubscribing does and does not do — a contact's subscription is consent for
 * campaigns, and it is not the suppression list, so putting them back here
 * neither checks nor changes whether their address is suppressed.
 */
export function resubscribeConfirmation(p: ResubscribePrompt): ResubscribeCopy {
  return {
    title: `Resubscribe ${p.email}?`,
    body: [
      `They unsubscribed on ${p.unsubscribedWhen}. ${reasonLine(p.reason)}`,
      "Only do this if they asked to come back. Campaigns to this book will include them again, and the record of when they left is cleared.",
    ].join(" "),
  };
}
