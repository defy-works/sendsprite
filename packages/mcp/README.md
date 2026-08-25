# @sendsprite/mcp

Model Context Protocol server for
[Sendsprite](https://github.com/defy-works/sendsprite) — the self-hostable
email API. It lets an MCP client (Claude Desktop, Claude Code, or anything
else that speaks MCP) send email through your instance, check what happened
to a message, and read your sending stats.

It talks to the same REST API with the same API key, so an agent can never do
more than the key you give it. Point it at a `sending_only` key unless the
agent genuinely needs to manage domains.

## Configuration

Two environment variables, both required:

| Variable             | Description                                     |
| -------------------- | ----------------------------------------------- |
| `SENDSPRITE_URL`     | Your instance, e.g. `https://mail.example.com`. |
| `SENDSPRITE_API_KEY` | An API key (`ss_live_…`).                       |

## stdio (Claude Desktop, Claude Code)

```json
{
  "mcpServers": {
    "sendsprite": {
      "command": "npx",
      "args": ["-y", "@sendsprite/mcp"],
      "env": {
        "SENDSPRITE_URL": "https://mail.example.com",
        "SENDSPRITE_API_KEY": "ss_live_..."
      }
    }
  }
}
```

The server writes to stderr only; stdout carries the JSON-RPC framing and
nothing else.

## Streamable HTTP

```bash
SENDSPRITE_URL=https://mail.example.com \
SENDSPRITE_API_KEY=ss_live_... \
npx @sendsprite/mcp --http 8787
```

Serves `POST /mcp` (default port 3333). Stateless: one server and one
transport per request, no session state, so it scales behind a load balancer
and survives a restart mid-conversation.

It does **not** authenticate its callers — the process holds your API key, so
put your own authentication in front of it and do not expose it to the
internet unguarded.

## Tools

| Tool               | Input                                       | Returns                                                                       |
| ------------------ | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `send_email`       | the full `POST /emails` body                | `{ id }`                                                                      |
| `get_email_status` | `{ id }`                                    | status, recipients, subject, `sentAt`, `lastError`, the 10 most recent events |
| `list_emails`      | `{ limit?, cursor?, status? }`              | `{ data, nextCursor }`                                                        |
| `search_emails`    | `{ to?, status?, tag?, domainId?, limit? }` | `{ data, nextCursor }`                                                        |
| `list_domains`     | —                                           | `{ data, nextCursor }` with each domain's verification status and DNS records |
| `get_send_stats`   | —                                           | sends today / 7 d / 30 d, 30-day rates, account-health alerts                 |

`send_email` is validated against the same zod contract the REST API uses —
including "one of `html`, `text` or `template` is required" and the recipient
cap — so a malformed call costs no round trip.

API failures come back as **tool errors**, not protocol errors: the agent
reads `{ error: { code, message, status } }` and can react to
`domain_not_verified` or `rate_limited` itself.

Template and contact tools are planned for a later release.

## As a library

```ts
import { createServer } from "@sendsprite/mcp";
import { Sendsprite } from "sendsprite";

const server = createServer(new Sendsprite());
await server.connect(yourTransport);
```
