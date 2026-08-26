import { CreateContactInput } from "@sendsprite/shared";
import { z } from "zod";
import { contactOutput } from "./output";
import { compact } from "./register";
import type { ToolRegistration } from "./register";
import { toolError, toolResult } from "./result";

/**
 * The `POST /contact-books/:id/contacts` body, minus its consent flag.
 *
 * Reusing the shared contract is what keeps the address rule, the 120-char
 * name bound and the 20-property cap identical here and at the API, and it
 * catches a bad address before a round trip. `subscribed` is dropped on
 * purpose: see the note on the tool.
 */
const contactFields = CreateContactInput.omit({ subscribed: true }).shape;

/**
 * Adds one person to one contact book — the only tool here that writes into a
 * customer's list on an agent's say-so. Three things follow from that.
 *
 * **The book is named, never guessed.** `bookId` is required and there is no
 * "the only book" fallback, so a model cannot decide for itself whose list a
 * person lands on. The id comes from the operator, the dashboard or the REST
 * API; if it is wrong the API says so.
 *
 * **An address already in the book is left exactly as it is.** The service
 * answers a duplicate with a `conflict` rather than an upsert, and this tool
 * reports that and stops. It deliberately does **not** retry as an update,
 * which is the one shortcut that would matter: a contact who unsubscribed is
 * still a row in that book, so a create-then-update fallback would silently
 * put someone who asked to be left alone back on the list. Unsubscribe is
 * consent, and consent is not ours to restore — a person who wants back in
 * says so through the dashboard or the REST API, where a human is present.
 *
 * **There is no `subscribed` argument.** Consent is asserted by the operator
 * calling the tool at all; a flag would be a field a model could reason its
 * way into setting, in either direction, and neither direction is its call.
 *
 * A contact is consent for campaigns. It is not the suppression list: adding
 * one does not enable transactional mail to that address, and this tool
 * cannot suppress an address or stop a send.
 */
export const registerAddContact: ToolRegistration = (server, client) =>
  server.registerTool(
    "add_contact",
    {
      title: "Add a contact to a book",
      description:
        "Add one person to a contact book on this instance. This writes to the operator's " +
        "contact list, so only call it when the person's address and the book were both given " +
        "to you — `bookId` is a `cb_…` id and is never guessed. Nothing is sent: a contact " +
        "records consent for future campaigns and does not affect transactional email. An " +
        "address already in the book is a `conflict` and is left untouched — including someone " +
        "who unsubscribed, who is not put back on the list by this or any other tool here.",
      inputSchema: {
        bookId: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .describe(
            "Contact book id (`cb_…`), supplied by the operator. There is no default book.",
          ),
        ...contactFields,
        email: contactFields.email.describe("The person's email address."),
        properties: contactFields.properties.describe(
          "Up to 20 custom string properties, 500 characters each.",
        ),
      },
      outputSchema: contactOutput,
      annotations: {
        readOnlyHint: false,
        // Additive and refused on conflict: it overwrites nothing.
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ bookId, email, properties, ...names }) => {
      try {
        const contact = await client.contacts.create(bookId, {
          email,
          properties,
          ...compact(names),
        });
        // The receipt, not the row. A create response is mostly the caller's
        // own input read back, and this one is a person's details — there is
        // nothing for the model to learn from a second copy of them. What it
        // does need is which contact was written, where, and with what
        // consent state, so that is what it gets.
        return toolResult({
          id: contact.id,
          bookId: contact.bookId,
          email: contact.email,
          subscribed: contact.subscribed,
        });
      } catch (e) {
        // Straight through — a `conflict` in particular. The tool must not
        // "fix" it by updating the existing contact (see the note above).
        return toolError(e);
      }
    },
  );
