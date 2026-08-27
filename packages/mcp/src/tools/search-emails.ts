import { z } from "zod";
import { limit, status } from "./list-emails";
import { pageOutput } from "./output";
import { compact, type ToolRegistration } from "./register";
import { toolError, toolResult } from "./result";

/**
 * `search_emails` is `list_emails` with the filter arguments spelled out.
 *
 * They hit the same endpoint, but a model picks a tool by its name and
 * description: "search by recipient" is not something it reliably discovers
 * behind a tool called `list_emails`.
 */
export const registerSearchEmails: ToolRegistration = (server, client) =>
  server.registerTool(
    "search_emails",
    {
      title: "Find emails by recipient, tag or domain",
      description:
        "Search the team's emails, newest first. Every filter is optional and they combine: " +
        "`to` matches a recipient address exactly, `tag` matches a `key:value` tag set at send " +
        "time, `domainId` narrows to one sending domain. Returns the same page envelope as " +
        "`list_emails`.",
      inputSchema: {
        to: z
          .string()
          .optional()
          .describe("Recipient address, matched exactly."),
        status,
        tag: z.string().optional().describe("Tag filter, as `key:value`."),
        domainId: z
          .string()
          .optional()
          .describe("Sending domain id, e.g. `dom_…` (see `list_domains`)."),
        limit,
        cursor: z
          .string()
          .optional()
          .describe("`nextCursor` from the previous page of this same search."),
      },
      outputSchema: pageOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ to, status, tag, domainId, limit, cursor }) => {
      try {
        return toolResult(
          await client.emails.list(
            compact({ to, status, tag, domainId, limit, cursor }),
          ),
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );
