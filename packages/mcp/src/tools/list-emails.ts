import { EMAIL_STATUS } from "@sendsprite/shared";
import { z } from "zod";
import { pageOutput } from "./output";
import { compact, type ToolRegistration } from "./register";
import { toolError, toolResult } from "./result";

/** Shared with `search_emails`; the server caps a page at 100. */
export const limit = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("Page size, 1–100. The instance defaults to 25.");

export const status = z
  .enum(EMAIL_STATUS)
  .optional()
  .describe("Only emails currently in this state.");

export const registerListEmails: ToolRegistration = (server, client) =>
  server.registerTool(
    "list_emails",
    {
      title: "List recent emails",
      description:
        "Page through the team's emails, newest first. Pass the `nextCursor` from the previous " +
        "result to continue; a null `nextCursor` means the last page. Use `search_emails` to " +
        "filter by recipient, tag or domain.",
      inputSchema: {
        limit,
        cursor: z
          .string()
          .optional()
          .describe("`nextCursor` from the previous page."),
        status,
      },
      outputSchema: pageOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ limit, cursor, status }) => {
      try {
        return toolResult(
          await client.emails.list(compact({ limit, cursor, status })),
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );
