import { SendEmailInput } from "@sendsprite/shared";
import { z } from "zod";
import type { ToolRegistration } from "./register";
import { toolError, toolResult } from "./result";

/**
 * `send_email` — the whole `POST /emails` contract, verbatim.
 *
 * The schema is the shared zod object rather than its raw shape so the two
 * cross-field rules (a body is required; at most 50 recipients) are checked
 * here instead of costing a round trip.
 */
export const registerSendEmail: ToolRegistration = (server, client) =>
  server.registerTool(
    "send_email",
    {
      title: "Send an email",
      description:
        "Send a transactional email through the connected Sendsprite instance. " +
        "`from` must be an address on a domain this instance has verified (see `list_domains`). " +
        "Supply `html`, `text` or a `template` name. Set `idempotencyKey` when a retry must not " +
        "send twice, and `scheduledAt` (ISO 8601 with offset, in the future) to queue for later. " +
        "Returns the email id, which `get_email_status` then tracks.",
      inputSchema: SendEmailInput,
      outputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      try {
        // Only `id`: the advertised output schema is closed, and clients
        // validate against it, so passing the response through verbatim would
        // break every one of them the day `POST /emails` grows a field.
        const { id } = await client.emails.send(input);
        return toolResult({ id });
      } catch (e) {
        return toolError(e);
      }
    },
  );
