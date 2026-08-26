import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Sendsprite } from "sendsprite";
import { registerAddContact } from "./tools/add-contact";
import { registerGetEmailStatus } from "./tools/get-email-status";
import { registerGetSendStats } from "./tools/get-send-stats";
import { registerListDomains } from "./tools/list-domains";
import { registerListEmails } from "./tools/list-emails";
import { registerListTemplates } from "./tools/list-templates";
import type { ToolRegistration } from "./tools/register";
import { registerRenderTemplate } from "./tools/render-template";
import { registerSearchEmails } from "./tools/search-emails";
import { registerSendEmail } from "./tools/send-email";

/** Reported in `initialize`; kept in sync with package.json by the release pipeline. */
export const MCP_VERSION = "0.1.0";

/**
 * The registry. Order is the order tools are advertised in `tools/list`, so
 * the ones a model reaches for first come first: sending, then tracking, then
 * the things to check before sending. `add_contact` is last because it is the
 * only one that writes into a customer's list and the least likely to be what
 * a request actually wants.
 */
const TOOLS: ToolRegistration[] = [
  registerSendEmail,
  registerGetEmailStatus,
  registerListEmails,
  registerSearchEmails,
  registerListDomains,
  registerListTemplates,
  registerRenderTemplate,
  registerGetSendStats,
  registerAddContact,
];

/**
 * An MCP server bound to one Sendsprite client.
 *
 * Transport-free on purpose: `src/bin.ts` connects it to stdio or to a
 * streamable HTTP transport, and the tests connect it to an in-memory pair.
 * Every tool reports API failures as `isError` results (see `tools/result.ts`),
 * so a rejected send never breaks the session.
 */
export function createServer(client: Sendsprite): McpServer {
  const server = new McpServer(
    { name: "sendsprite", version: MCP_VERSION },
    {
      instructions:
        "Tools for a Sendsprite instance: send transactional email, track what happened to it, " +
        "and inspect sending domains, templates and deliverability. Check `list_domains` before " +
        "sending from an unfamiliar address — only verified domains are allowed — and " +
        "`list_templates` before naming a template, since every `{{ variable }}` it uses must be " +
        "supplied. `add_contact` writes to the operator's own contact list and is the one tool " +
        "here that changes who they can mail later; it sends nothing, and nothing here can put " +
        "an unsubscribed address back on a list.",
    },
  );
  for (const register of TOOLS) register(server, client);
  return server;
}
