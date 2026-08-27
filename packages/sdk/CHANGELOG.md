# sendsprite

## 0.4.0

### Minor Changes

- 01f3a35: Default to the hosted instance at `https://sendsprite.com`. `baseUrl` / `SENDSPRITE_URL` and `sendsprite login --url` are now only needed for a self-hosted Sendsprite; the SDK exports the default as `DEFAULT_BASE_URL`. `SENDSPRITE_API_KEY` alone is enough for the CLI and the MCP server.

## 0.3.0

### Minor Changes

- 5f70cb3: Campaign bodies gain columns, per-block presentation and a body theme.

  Purely additive — every field is optional, and a body written against the
  previous types still sends the same email:

  - `HeadingBlock`, `TextBlock`: `align`, `color`.
  - `ButtonBlock`: `align`, `color`, `textColor`, `corners`, `fullWidth`.
  - `ImageBlock`: `align`, `width` (25/50/75/100), `corners`.
  - `DividerBlock`: `color`.
  - New `ColumnsBlock` — a row of two or three columns from four ratio presets
    (`1-1`, `1-1-1`, `2-1`, `1-2`), holding up to 20 blocks each. It cannot
    nest: the Word engine behind Outlook on Windows measures an inner table
    against the wrong containing block, so `CampaignBlock` is now
    `LeafBlock | ColumnsBlock` and a column takes leaves only.
  - New `CampaignTheme` on create, update and the returned campaign — page and
    card colour, content width, font family, text and link colour, card
    corners. Absent (or `null` on a returned campaign) means the renderer's
    defaults, which is byte-for-byte what a campaign rendered before themes
    existed.

## 0.2.0

### Minor Changes

- 9b83073: Initial release.
- 9b83073: Templates and contacts.

  **Send a stored template.** `emails.send({ template: "welcome", variables: { name: "Ada" } })` renders server-side and stores what it sent. `template` replaces `html`/`text` rather than joining them — passing both is refused — and `subject` becomes optional when the template supplies one. Values are HTML-escaped into the HTML body and left raw in the text body; every placeholder must resolve, so a missing variable is a `validation_error` naming it rather than a blank in someone's inbox. Declare a `default` to make a variable optional.

  **New client namespaces.** `templates` (`list`, `iterate`, `get`, `create`, `update`, `render`, `remove`), `contactBooks` (`list`, `get`, `create`, `update`, `import`, `remove`) and `contacts` (`list`, `iterate`, `get`, `create`, `update`, `remove`, `unsubscribe`). `templates.render()` returns exactly what a send would store, without sending anything. All of them need a `full` key.

  **New CLI commands.** `sendsprite templates pull <dir>` and `sendsprite templates push <dir>` keep templates in your repository as `<slug>.json` / `<slug>.html` / `<slug>.txt`. `push` never deletes a remote template, and a missing `.txt` means "no opinion" rather than "clear the text body". Both take `--dry-run`.

  **New MCP tools.** `list_templates`, `render_template` and `add_contact`. The first two need a `full` key. `add_contact` never guesses a book, never overwrites an existing contact, and has no `subscribed` argument — an unsubscribed person is not put back on a list by an agent.

  **Contact subscription is consent, not deliverability.** Unsubscribing a contact excludes them from campaigns and writes no suppression, so they still receive password resets and receipts. Suppression is the separate, team-wide thing that stops every send to an address.

  Three behaviour changes on the send path, which reach every client, not only this one:

  - **Control characters are refused everywhere they could reach a header.** `subject`, all address fields, an attachment's `filename` and `contentType`, custom header values and tag values now reject every C0 control character and DEL, not only CR and LF. **This includes the tab**, which RFC 5322 permits as whitespace: it is the folding-continuation character and so the second half of a header-injection primitive. A send that previously slipped a tab into a subject is now a 422 saying the value "must not contain line breaks or control characters".
  - **`subject` is trimmed on every send.** `"  Hello  "` is stored and sent as `"Hello"`, a whitespace-only subject is a `validation_error` instead of a blank header, and — when a template supplies its own subject — a whitespace-only request subject counts as absent so the template's wins. If you retry a send with an `idempotencyKey` created before this change and an untrimmed subject, the retry can report an `idempotency_conflict`.
  - **`required` is gone from the template variable schema.** The renderer refuses every unresolved placeholder, so `required: true` was a no-op and `required: false` could only have meant "render nothing here" — the silent blank the refusal exists to prevent. A `default` is how a variable is made optional. An unknown `required` key from an older client is stripped, not rejected.

- 9b83073: Campaigns.

  **New `campaigns` namespace.** `list`, `iterate`, `get`, `create`, `update`, `remove`, `schedule`, `sendNow`, `cancel` and `audience`. A campaign is one message to one contact book, authored as a typed block list — `heading`, `text`, `button`, `image`, `divider`, `spacer` — rather than free HTML: the server renders it to table-based email HTML and a plain-text alternative, escaping every value it interpolates, and every URL must be an absolute `http:`, `https:` or `mailto:` one. Every method needs a **`full`** key, reads included; a `sending_only` key gets a `403` on all eight routes, because a key deployed to send password resets must not be one `POST` away from mailing a customer's whole contact book.

  **`schedule(id, at)` takes a required time and `sendNow(id)` is a separate verb.** Deliberately two methods rather than one with an optional argument: a method that mails everyone on a contact book when you forget its second argument is the wrong shape for an irreversible action. `schedule(id)` does not compile. `sendNow()` is not retried on a timeout either — a resend would be a second campaign to the same list, which is worse than an error you can act on. Call `audience(id)` first; its `eligible` is the number a send will actually reach.

  **`campaign.sent` means every recipient was queued, not that anyone received it.** It fires when the fan-out has nobody left to materialise — every message exists and is on its way to the provider, and the delivery window has only just begun. `campaign.completed` is the one to wait on before reading a campaign's numbers: it fires when every message the campaign queued has reached a terminal state, and its payload carries the final `counts`. Both are new webhook event types, both carry `data.campaign`, and both fire exactly once. A cancelled campaign fires neither.

  **A campaign mails a contact only if they are subscribed _and_ not suppressed.** Consent and deliverability stay two separate lists everywhere else — leaving a newsletter must not stop a password reset — and campaign selection is the one read where both apply. `audience()` returns `contacts`, `subscribed`, `suppressed` and `eligible`; they are four views of one population, not four buckets that sum to it.

  **`cancel()` stops the fan-out, it does not recall mail.** `scheduled` → `draft` un-arms a campaign that has sent nothing; `sending` → `cancelled` is terminal and stops only the recipients not yet materialised. Anything already handed to the provider goes out, and `counts` keeps rising for a while afterwards as delivery and open events land.

  **New unsubscribe endpoints, unauthenticated by design.** Every campaign message carries a per-recipient link in its body and an RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` header pair. `GET /unsubscribe/<token>` renders a page and **changes nothing** — mail security scanners fetch every link in an incoming message, so a mutating GET would unsubscribe people who never touched it — and `POST /api/unsubscribe/<token>` is the one-click endpoint mail clients call. The two URLs are different routes carrying the same token. Tokens are stateless HMACs over the contact and campaign ids keyed by the instance's `APP_SECRET`; rotating that secret invalidates every outstanding link. Unsubscribing writes no suppression, so the address still receives transactional mail.

  **Pagination.** `campaigns.iterate()` joins `emails`, `templates` and `contacts` as the fourth namespace with an async iterator. The package README previously named only `emails.iterate()`, which had been out of date since the previous release.
