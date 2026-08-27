# @sendsprite/mcp

## 0.2.1

### Patch Changes

- Updated dependencies [5f70cb3]
  - sendsprite@0.3.0

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

### Patch Changes

- Updated dependencies [9b83073]
- Updated dependencies [9b83073]
- Updated dependencies [9b83073]
  - sendsprite@0.2.0
