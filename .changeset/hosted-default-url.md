---
"sendsprite": minor
"@sendsprite/mcp": minor
---

Default to the hosted instance at `https://sendsprite.com`. `baseUrl` / `SENDSPRITE_URL` and `sendsprite login --url` are now only needed for a self-hosted Sendsprite; the SDK exports the default as `DEFAULT_BASE_URL`. `SENDSPRITE_API_KEY` alone is enough for the CLI and the MCP server.
