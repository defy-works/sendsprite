import { z } from "zod";
import { emailStatusOutput } from "./output";
import type { ToolRegistration } from "./register";
import { toolError, toolResult } from "./result";

/**
 * How many timeline entries come back. A long-lived email accumulates opens
 * and clicks indefinitely; the newest ten answer "what happened to it?"
 * without flooding the model's context.
 */
const RECENT_EVENTS = 10;

export const registerGetEmailStatus: ToolRegistration = (server, client) =>
  server.registerTool(
    "get_email_status",
    {
      title: "Get the delivery status of an email",
      description:
        "Look up one email by the id returned from `send_email` and report where it got to: " +
        `its status, when it was sent, the last error if it failed, and its ${RECENT_EVENTS} most ` +
        "recent delivery events (oldest first).",
      inputSchema: { id: z.string().min(1).describe("Email id, e.g. `em_…`.") },
      outputSchema: emailStatusOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        const email = await client.emails.get(id);
        return toolResult({
          id: email.id,
          status: email.status,
          to: email.to,
          subject: email.subject,
          sentAt: email.sentAt,
          lastError: email.lastError,
          events: (email.events ?? []).slice(-RECENT_EVENTS),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
