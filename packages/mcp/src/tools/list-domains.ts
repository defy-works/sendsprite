import type { ToolRegistration } from "./register";
import { toolError, toolResult } from "./result";

/**
 * No arguments: a team has a handful of domains, and the answer the model
 * needs — "which addresses may I send from?" — is the whole list.
 */
export const registerListDomains: ToolRegistration = (server, client) =>
  server.registerTool(
    "list_domains",
    {
      title: "List sending domains",
      description:
        "List the domains configured on this instance with their verification status and DNS " +
        "records. Only a domain whose status is `verified` can appear in `send_email`'s `from`; " +
        "a `pending` one is still waiting on the DNS records listed here.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return toolResult(await client.domains.list());
      } catch (e) {
        return toolError(e);
      }
    },
  );
