import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Sendsprite } from "sendsprite";

/**
 * One entry of the tool registry in `src/server.ts`.
 *
 * Every tool is a function of `(server, client)` rather than a data structure
 * so the MCP SDK can infer each handler's argument type from its own input
 * schema. Adding a tool — the Phase 6 `list_templates`, `render_template` and
 * `add_contact` — means writing one of these and appending it to the array.
 */
export type ToolRegistration = (server: McpServer, client: Sendsprite) => void;

/** Drops `undefined` values so a query object matches exactly what was asked for. */
export function compact<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
