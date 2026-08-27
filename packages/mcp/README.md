# @sendsprite/mcp

Model Context Protocol server for
[Sendsprite](https://github.com/defy-works/sendsprite) — the self-hostable
email API. It lets an MCP client (Claude Desktop, Claude Code, or anything
else that speaks MCP) send email through your instance, check what happened
to a message, and read your sending stats.

It talks to the same REST API with the same API key, so an agent can never do
more than the key you give it. Only `send_email` works with a
`sending_only` key; the other tools read emails, domains, templates and
stats, which need a `full` key.

## Configuration

| Variable              | Description                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `SENDSPRITE_API_KEY`  | **Required.** An API key (`ss_live_…`).                                                        |
| `SENDSPRITE_URL`      | A self-hosted instance, e.g. `https://mail.example.com`. Defaults to `https://sendsprite.com`. |
| `SENDSPRITE_MCP_HOST` | `--http` bind address. Defaults to `127.0.0.1`; read below before changing it.                 |

## stdio (Claude Desktop, Claude Code)

```json
{
  "mcpServers": {
    "sendsprite": {
      "command": "npx",
      "args": ["-y", "@sendsprite/mcp"],
      "env": {
        "SENDSPRITE_API_KEY": "ss_live_..."
      }
    }
  }
}
```

The server writes to stderr only. stdout is reserved for the JSON-RPC framing:
the whole `console` is rebuilt over stderr and `process.stdout.write` is
redirected there too, so a dependency that logs cannot corrupt the protocol
stream.

## Streamable HTTP

```bash
SENDSPRITE_API_KEY=ss_live_... npx @sendsprite/mcp --http 8787
```

Serves `POST /mcp` (default port 3333). Stateless: one server and one
transport per request, no session state, so it scales behind a load balancer
and survives a restart mid-conversation.

It does **not** authenticate its callers — the process holds your API key. So:

- **It binds `127.0.0.1` by default.** Set `SENDSPRITE_MCP_HOST` to listen
  anywhere else, and put your own authentication in front of it when you do;
  the server prints a warning at startup as a reminder.
- **DNS rebinding protection is on for loopback binds.** Only `Host` headers
  naming `localhost`, `127.0.0.1` or `[::1]` on the bound port are accepted, so
  a page in your browser cannot resolve its own name to `127.0.0.1` and drive
  your MCP server. Overriding the bind address turns host validation off,
  because a proxy in front will legitimately send its own `Host`.
- **Request bodies are capped at 20 MB.** A larger declared `content-length` is
  refused with `413` before a byte is read, and a chunked body is cut off once
  the counter passes the cap rather than buffered to exhaustion.

Other paths return `404` and non-`POST` methods `405`, both as JSON-RPC error
envelopes. There is no `GET` or `DELETE`: with no sessions there is no stream
to resume and none to end. `SIGTERM`/`SIGINT` close the listener and drain.

## Tools

| Tool               | Input                                                   | Returns                                                                       |
| ------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `send_email`       | the full `POST /emails` body                            | `{ id }`                                                                      |
| `get_email_status` | `{ id }`                                                | status, recipients, subject, `sentAt`, `lastError`, the 10 most recent events |
| `list_emails`      | `{ limit?, cursor?, status? }`                          | `{ data, nextCursor }`                                                        |
| `search_emails`    | `{ to?, status?, tag?, domainId?, limit?, cursor? }`    | `{ data, nextCursor }`                                                        |
| `list_domains`     | —                                                       | `{ data, nextCursor }` with each domain's verification status and DNS records |
| `list_templates`   | —                                                       | `{ data, nextCursor }` with each template's `slug`, subject and variables     |
| `render_template`  | `{ slug, variables? }`                                  | `{ subject, html, text }` — a dry run; the variables are not echoed back      |
| `get_send_stats`   | —                                                       | sends today / 7 d / 30 d, 30-day rates, account-health alerts                 |
| `add_contact`      | `{ bookId, email, firstName?, lastName?, properties? }` | `{ id, bookId, email, subscribed }`                                           |

`send_email` and `add_contact` are validated against the same zod contracts the
REST API uses — including "one of `html`, `text` or `template` is required",
the recipient cap and the contact address rule — so a malformed call costs no
round trip.

API failures come back as **tool errors**, not protocol errors: the agent
reads `{ error: { code, message, status } }` and can react to
`domain_not_verified` or `rate_limited` itself.

Every tool advertises an output schema. The read tools' schemas are
deliberately open (`additionalProperties`), so a new field on the REST API
never becomes a validation error inside your MCP client.

`add_contact` is the only tool that writes to your contact list. It names the
book explicitly — there is no default book — and an address already in that
book comes back as `conflict` and is left untouched. That is on purpose: a
contact who unsubscribed is still a row in the book, so a create-then-update
fallback would put someone who asked to be left alone back on the list. No
tool here can resubscribe an address, and none of them writes a suppression.

## As a library

```ts
import { createServer } from "@sendsprite/mcp";
import { Sendsprite } from "sendsprite";

const server = createServer(new Sendsprite());
await server.connect(yourTransport);
```

## License

MIT — see `LICENSE`. This package is deliberately permissive so it can be
embedded in closed-source applications: installing it puts you under no
obligation to publish anything. The Sendsprite _server_ is FSL-1.1-MIT, which
does not reach your code.
