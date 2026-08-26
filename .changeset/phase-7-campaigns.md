---
"sendsprite": minor
---

Campaigns.

**New `campaigns` namespace.** `list`, `iterate`, `get`, `create`, `update`, `remove`, `schedule`, `sendNow`, `cancel` and `audience`. A campaign is one message to one contact book, authored as a typed block list — `heading`, `text`, `button`, `image`, `divider`, `spacer` — rather than free HTML: the server renders it to table-based email HTML and a plain-text alternative, escaping every value it interpolates, and every URL must be an absolute `http:`, `https:` or `mailto:` one. Every method needs a **`full`** key, reads included; a `sending_only` key gets a `403` on all eight routes, because a key deployed to send password resets must not be one `POST` away from mailing a customer's whole contact book.

**`schedule(id, at)` takes a required time and `sendNow(id)` is a separate verb.** Deliberately two methods rather than one with an optional argument: a method that mails everyone on a contact book when you forget its second argument is the wrong shape for an irreversible action. `schedule(id)` does not compile. `sendNow()` is not retried on a timeout either — a resend would be a second campaign to the same list, which is worse than an error you can act on. Call `audience(id)` first; its `eligible` is the number a send will actually reach.

**`campaign.sent` means every recipient was queued, not that anyone received it.** It fires when the fan-out has nobody left to materialise — every message exists and is on its way to the provider, and the delivery window has only just begun. `campaign.completed` is the one to wait on before reading a campaign's numbers: it fires when every message the campaign queued has reached a terminal state, and its payload carries the final `counts`. Both are new webhook event types, both carry `data.campaign`, and both fire exactly once. A cancelled campaign fires neither.

**A campaign mails a contact only if they are subscribed _and_ not suppressed.** Consent and deliverability stay two separate lists everywhere else — leaving a newsletter must not stop a password reset — and campaign selection is the one read where both apply. `audience()` returns `contacts`, `subscribed`, `suppressed` and `eligible`; they are four views of one population, not four buckets that sum to it.

**`cancel()` stops the fan-out, it does not recall mail.** `scheduled` → `draft` un-arms a campaign that has sent nothing; `sending` → `cancelled` is terminal and stops only the recipients not yet materialised. Anything already handed to the provider goes out, and `counts` keeps rising for a while afterwards as delivery and open events land.

**New unsubscribe endpoints, unauthenticated by design.** Every campaign message carries a per-recipient link in its body and an RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` header pair. `GET /unsubscribe/<token>` renders a page and **changes nothing** — mail security scanners fetch every link in an incoming message, so a mutating GET would unsubscribe people who never touched it — and `POST /api/unsubscribe/<token>` is the one-click endpoint mail clients call. The two URLs are different routes carrying the same token. Tokens are stateless HMACs over the contact and campaign ids keyed by the instance's `APP_SECRET`; rotating that secret invalidates every outstanding link. Unsubscribing writes no suppression, so the address still receives transactional mail.

**Pagination.** `campaigns.iterate()` joins `emails`, `templates` and `contacts` as the fourth namespace with an async iterator. The package README previously named only `emails.iterate()`, which had been out of date since the previous release.
