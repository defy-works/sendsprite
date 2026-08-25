import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Sendsprite } from "sendsprite";
import { registerGetEmailStatus } from "./tools/get-email-status";
import { registerGetSendStats } from "./tools/get-send-stats";
import { registerListDomains } from "./tools/list-domains";
import { registerListEmails } from "./tools/list-emails";
import type { ToolRegistration } from "./tools/register";
import { registerSearchEmails } from "./tools/search-emails";
import { registerSendEmail } from "./tools/send-email";

/** Reported in `initialize`; kept in sync with package.json by the release pipeline. */
export const MCP_VERSION = "0.1.0";

/**
 * The registry. Order is the order tools are advertised in `tools/list`, so
 * the ones a model reaches for first come first. Phase 5 appends
 * `list_templates`, `render_template` and `add_contact` here.
 */
const TOOLS: ToolRegistration[] = [
  registerSendEmail,
  registerGetEmailStatus,
  registerListEmails,
  registerSearchEmails,
  registerListDomains,
  registerGetSendStats,
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
        "and inspect sending domains and deliverability. Check `list_domains` before sending " +
        "from an unfamiliar address — only verified domains are allowed.",
    },
  );
  for (const register of TOOLS) register(server, client);
  return server;
}
