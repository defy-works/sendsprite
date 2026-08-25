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
  baseUrl: "https://mail.acme.com", // your instance
});
```

`apiKey` and `baseUrl` fall back to the `SENDSPRITE_API_KEY` and
`SENDSPRITE_URL` environment variables.

### Options

| Option       | Default              | Description                                  |
| ------------ | -------------------- | -------------------------------------------- |
| `apiKey`     | `SENDSPRITE_API_KEY` | API key with the permissions the call needs. |
| `baseUrl`    | `SENDSPRITE_URL`     | Instance origin; `/api/v1` is appended.      |
| `maxRetries` | `2`                  | Retries on 429, 5xx and network errors.      |
| `timeoutMs`  | `30000`              | Per-request timeout.                         |
| `fetch`      | `globalThis.fetch`   | Custom fetch implementation.                 |

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

### Retries

Requests that fail with 429, 5xx or a network error are retried with
exponential backoff (500 ms · 2ⁿ ± 20 %, capped at 8 s) and honour
`retry-after`. `POST` requests are not retried unless `retry: true` is
passed — the resource helpers do this for calls that are safe to repeat.

## License

MIT
