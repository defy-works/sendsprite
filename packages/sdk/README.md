# sendsprite

TypeScript SDK, React email helpers, Next.js webhook handler and CLI for
[Sendsprite](https://github.com/defy-works/sendsprite) — the self-hostable
email API.

```bash
npm install sendsprite
```

## Usage

```ts
import { Sendsprite } from "sendsprite";

const sendsprite = new Sendsprite({
  apiKey: process.env.SENDSPRITE_API_KEY, // ss_live_…
});
```

That talks to the hosted instance at `https://sendsprite.com`. Self-hosting?
Pass `baseUrl: "https://mail.acme.com"` (or set `SENDSPRITE_URL`). `apiKey`
falls back to the `SENDSPRITE_API_KEY` environment variable.

### Options

| Option       | Default                                         | Description                                  |
| ------------ | ----------------------------------------------- | -------------------------------------------- |
| `apiKey`     | `SENDSPRITE_API_KEY`                            | API key with the permissions the call needs. |
| `baseUrl`    | `SENDSPRITE_URL`, else `https://sendsprite.com` | Instance origin; `/api/v1` is appended.      |
| `maxRetries` | `2`                                             | Retries on 429, 5xx and network errors.      |
| `timeoutMs`  | `30000`                                         | Per-request timeout.                         |
| `fetch`      | `globalThis.fetch`                              | Custom fetch implementation.                 |

### Errors

Every failed call throws a `SendspriteError` with `code`, `status`,
`message`, `details` and `requestId`:

```ts
import { SendspriteError } from "sendsprite";

try {
  await sendsprite.request("GET", "/me");
} catch (err) {
  if (err instanceof SendspriteError && err.code === "unauthorized") {
    // rotate the key
  }
}
```

### Resources

```ts
const { id } = await sendsprite.emails.send({
  from: "Acme <hello@mail.acme.com>",
  to: "ada@example.com",
  subject: "Welcome",
  html: "<p>Hi Ada</p>",
  idempotencyKey: "welcome-ada-1", // optional; makes the send safely retryable
});
const email = await sendsprite.emails.get(id);
for await (const e of sendsprite.emails.iterate({ status: "delivered" })) {
  console.log(e.id);
}

await sendsprite.domains.create({ name: "mail.acme.com" });
await sendsprite.webhooks.create({
  url: "https://acme.com/hooks",
  events: ["email.delivered"],
});
await sendsprite.suppressions.add({ email: "bounce@example.com" });

// Campaigns: `schedule(id, at)` needs a time; `sendNow(id)` is a separate
// verb, so an irreversible send cannot be triggered by a forgotten argument.
const campaign = await sendsprite.campaigns.create({
  name: "August newsletter",
  bookId,
  domainId,
  from: "Acme <hello@mail.acme.com>",
  subject: "What we shipped",
  blocks: [{ kind: "heading", level: 1, text: "What we shipped" }],
});
await sendsprite.campaigns.audience(campaign.id); // who it would reach
await sendsprite.campaigns.schedule(campaign.id, new Date("2026-09-01T09:00Z"));

const key = await sendsprite.apiKeys.create({ name: "ci" }); // `key.secret`
const stats = await sendsprite.stats();
const me = await sendsprite.me();
```

Every `list()` returns `{ data, nextCursor }` and accepts `{ limit, cursor }`.
`emails`, `templates`, `contacts` and `campaigns` each have an `iterate()` that
walks all pages for you; the rest take a manual `nextCursor` loop.

### Live changes

```ts
const stream = sendsprite.stream({
  onChange: ({ type, id }) => console.log(type, id),
  onError: (err) => console.warn("reconnecting after", err.code),
});
await stream.ready; // the server has the subscription; nothing can be missed
await sendsprite.emails.send(welcome); // its changes are guaranteed to arrive
// later
stream.close();
await stream.done;
```

`stream()` connects to `GET /api/v1/stream` (server-sent events) and needs a
`full` key. Dropped connections are re-established with backoff unless
`reconnect: false`; pass a `signal` to close it from an `AbortController`.

`stream()` only _starts_ connecting, so await `ready` before triggering
whatever you opened the stream to watch — a change emitted before the server
has the subscription is gone, and no timeout brings it back. `ready` rejects
(it never hangs) if the stream ends before it ever opened, including when the
connect exceeds `timeoutMs`.

### Retries

Requests that fail with 429, 5xx or a network error are retried with
exponential backoff (500 ms · 2ⁿ ± 20 %, capped at 8 s) and honour
`retry-after` (seconds or HTTP-date, capped at 60 s). `POST` requests are
not retried unless `retry: true` is passed — the resource helpers do this for
calls that are safe to repeat (`cancel`, `verify`, `test`, and sends with an
`idempotencyKey`).

`request(method, path, { body, query, retry, signal })` is the escape hatch
for endpoints without a helper; `signal` aborts both the in-flight fetch and
any pending retry delay.

## License

MIT — see `LICENSE`. This package is deliberately permissive so it can be
embedded in closed-source applications: installing it puts you under no
obligation to publish anything. The Sendsprite _server_ is AGPL-3.0-only, which
does not reach your code.
