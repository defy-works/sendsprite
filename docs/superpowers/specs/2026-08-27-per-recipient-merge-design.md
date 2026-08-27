# Per-recipient merge fields in campaigns

**Date:** 2026-08-27
**Status:** approved (both forks decided), implementing

## Problem

A campaign renders one body and sends it to everyone. The only per-recipient
content is the unsubscribe link, substituted in the fan-out for a control-
character marker. Authors want `Hi {{ firstName }}` and
`{{ properties.company }}` — content that varies by contact.

## What already exists (and is reused)

- `packages/shared/src/template.ts` — a `{{ name }}` engine with dotted paths
  (`{{ a.b.c }}`), HTML escaping per field, prototype-pollution-safe lookup, a
  subject control-character (header-injection) guard, and per-variable
  `default`s. Built for transactional templates.
- The fan-out already **renders once per campaign and rewrites per recipient**
  (`services/campaigns/fanout.ts` `body()`), which is exactly where a
  per-recipient substitution belongs.

The engine's one mismatch: a transactional template _fails_ on a missing
value (so nobody mails "Hi ,"). A campaign must not fail a whole send because
one contact lacks a first name.

## Decisions

| Question         | Decision                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| Missing value    | Empty by default; the author may set a per-field fallback (e.g. `firstName` → "there").         |
| Non-scalar value | `{{ properties }}` (a whole object) is treated as blank → fallback/empty, never `[object …]`.   |
| Subject safety   | Substituted values in the **subject** have control characters stripped (header-injection).      |
| Namespace        | `email`, `firstName`, `lastName`, and `properties.<key>` per recipient.                         |
| Contract         | `mergeDefaults` is optional on campaign create/update and the returned campaign (like `theme`). |
| Performance      | A campaign with no `{{ }}` keeps the current once-rendered fast path untouched.                 |

## Engine — `renderCampaignFields` (shared)

A campaign-semantics sibling of `renderTemplate`, in the same file so it reuses
the private `lookup`, `resolve`, `placeholder`, size limits and control-char
rule:

```ts
renderCampaignFields(
  fields: { subject: string; html: string; text: string },
  values: Record<string, unknown>,          // { email, firstName, lastName, properties }
  defaults: Record<string, string> = {},    // author fallbacks by placeholder name
): { subject: string; html: string; text: string } | { error: string }
```

Per placeholder: `raw = lookup(values, name)`; if blank or non-scalar, use
`defaults[name] ?? ""`. `html` HTML-escapes values; `text` does not; `subject`
does not escape but strips control characters from each substituted value.
Size caps as in `renderTemplate`; overflow returns `{ error }`, which the
fan-out turns into a deferral exactly like a block-render failure. Never
reports "missing" — every name resolves. Strict `renderTemplate` is untouched.

## Data model

`campaigns.merge_defaults jsonb` (migration 0031), nullable, `Record<string,
string>`. Keys must match the placeholder grammar; values are
`NO_CONTROL_CHARS`, ≤ 200 chars; ≤ 100 entries. Same validation in the REST
contract.

## Fan-out

- `EligibleContact` and `selectEligible` gain `properties` (jsonb).
- `campaignUsesMerge(campaign)` = any placeholder in `subject` + stored
  `html`/`text`. Computed once.
- When false: the existing `body()` path, unchanged.
- When true: per recipient, after tracking and before the unsubscribe marker
  swap, run `renderCampaignFields` over `{ subject, html, text }` with the
  contact's fields and the campaign's `mergeDefaults`. The marker is a control
  character and survives the merge; tracking rewrites hrefs, which merge does
  not touch. The per-recipient `subject` replaces the static one.
- A merge field inside a **link URL** is out of scope: button URLs are authored
  static values in the editor, and `wrapLinks` runs before substitution. Noted,
  not supported.

## Editor

A "Personalization" panel on the campaign editor: the fields available
(`email`, `firstName`, `lastName`, `properties.<key>`), the placeholders it
detects in the subject and blocks (`placeholderNames`), and a fallback input
per detected placeholder, saved as `mergeDefaults`. The live preview
substitutes sample values so the author sees a real recipient's view.

## Testing

- **shared unit** — escaping (html vs text vs subject), missing → empty, author
  fallback, non-scalar → empty, subject control-char strip, size overflow,
  the no-placeholder fast path returning inputs unchanged.
- **integration** — two contacts get different subject/body from one campaign;
  a missing field is empty, or the fallback; an HTML-unsafe value is escaped in
  the body; contract rejects a bad `mergeDefaults`.
- **e2e** — untouched; the send spec already exercises the fan-out.
