/**
 * `@sendsprite/mcp` as a library: build the server and connect it to whatever
 * transport the host already has. `npx sendsprite-mcp` (`src/bin.ts`) is the
 * same server behind stdio or streamable HTTP.
 */
export { createServer, MCP_VERSION } from "./server";
export { toolError, toolResult, type ToolTextResult } from "./tools/result";
export type { ToolRegistration } from "./tools/register";
