import { z } from "zod";
import { MAX_SUBJECT_CHARS, NO_CONTROL_CHARS } from "../template";
import { EmailAddressField } from "./emails";

/**
 * Contracts for `/api/v1/campaigns` (spec §5, §10). Shared with the SDK and
 * the OpenAPI generator, so every schema here must stay
 * `z.toJSONSchema`-representable: `.refine`/`.superRefine` are fine (the
 * emitter ignores them) and `.trim()` is an `overwrite` check that keeps the
 * string type; a `.transform()` is not.
 *
 * ## A campaign's body is a typed block list, not free HTML
 *
 * That is the whole safety model. `renderBlocks` turns the list into
 * table-based email HTML, escaping every value it interpolates, so there is no
 * arbitrary markup to sanitise and no path from the editor to a `<script>`.
 *
 * Two fields escape that guarantee and are therefore the two that matter here:
 *
 * - **`text.html`** is emitted as markup, *unescaped*, on the strength of
 *   `INLINE_HTML_RE` and `isWellNested` alone. It is the only such field in
 *   the phase.
 * - **`SafeUrl`** ends up inside an `href`/`src`, where escaping is no defence
 *   at all: `escapeHtml("javascript:alert(1)")` is still a working
 *   `javascript:` URL. Only a scheme allow-list helps.
 *
 * Both are validated once, here, and every downstream consumer — the renderer,
 * the dashboard preview, the send — trusts the result. Loosening either is a
 * change to the security boundary of the editor, not a change to a validator.
 */

export const CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "cancelled",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Blocks in one campaign body. An authored email, not a generated document. */
export const MAX_BLOCKS = 100;
/** Characters in one block's text or inline HTML. */
export const MAX_BLOCK_TEXT_CHARS = 10_000;
export const MAX_CAMPAIGN_NAME_CHARS = 200;
/** The de facto ceiling every mail client and proxy agrees on. */
export const MAX_URL_CHARS = 2_048;

/**
 * Schemes allowed anywhere a block carries a URL.
 *
 * `escapeHtml` makes `javascript:alert(1)` safe as *text* and completely
 * useless as an `href` — escaping never touched the scheme. Phase 6 recorded
 * this as opener 4; campaigns are where it stops being optional, because a
 * campaign body is rendered into a dashboard preview and mailed to thousands.
 */
const SAFE_SCHEMES = ["http:", "https:", "mailto:"];

/**
 * Characters a URL must percent-encode, refused literally.
 *
 * Two distinct reasons, both of which `new URL()` alone misses:
 *
 * 1. **The parsed URL is not the stored URL.** The refine below validates
 *    `new URL(raw)`, but `raw` is what gets stored and what the renderer puts
 *    between the quotes of `href="…"`. `https://x.test/" onmouseover="alert(1)`
 *    is a *valid* URL whose `protocol` is `https:` — the parser percent-encodes
 *    the quote on the way out and never objects — and it closes the attribute
 *    the moment it is written out raw.
 * 2. **The WHATWG parser strips ASCII tab and newline before parsing.** So
 *    `ht<TAB>tps://x` validates as `https:` while the stored string is
 *    something else. Validating a normalised value and storing the raw one is
 *    the bug; refusing the characters is the fix.
 *
 * The backslash is in the set for the same reason: special schemes treat it as
 * `/`, so `https:/\evil.test` validates with a host the author never typed.
 */
const URL_LITERAL_CHARS = /^[^\s"'`<>\\]*$/;

/**
 * An absolute `http:`, `https:` or `mailto:` URL, safe to write into an
 * attribute verbatim.
 *
 * `new URL()` is the parser rather than a regex on purpose — it is the same
 * algorithm the recipient's client will run — but it is deliberately not the
 * only check: see `URL_LITERAL_CHARS` above for what it lets through, and the
 * credentials refine below for what it happily calls valid.
 *
 * Protocol-relative `//host/path` is refused as a side effect worth stating:
 * `new URL()` throws on it without a base, and a link that inherits whatever
 * scheme the reader's client used is a downgrade waiting to happen.
 */
export const SafeUrl = z
  .string()
  .trim()
  .min(1, "A URL is required.")
  .max(MAX_URL_CHARS, `A URL must be at most ${MAX_URL_CHARS} characters.`)
  .regex(NO_CONTROL_CHARS, "A URL must not contain control characters.")
  .regex(
    URL_LITERAL_CHARS,
    "A URL must not contain spaces, quotes or angle brackets — percent-encode them.",
  )
  .refine((raw) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    return SAFE_SCHEMES.includes(u.protocol);
  }, "URL must be absolute and start with http://, https:// or mailto:.")
  /*
   * `https://example.com@evil.test/login` points at `evil.test` and reads as
   * `example.com`. It is the oldest phishing trick there is, it survives every
   * scheme check because the scheme really is `https:`, and no legitimate
   * campaign link has ever carried credentials.
   */
  .refine((raw) => {
    try {
      const u = new URL(raw);
      return u.username === "" && u.password === "";
    } catch {
      return false;
    }
  }, "A URL must not contain a username or password.");

/** Plain text inside a block: no control characters, same rule as a subject. */
const BlockText = z
  .string()
  .max(MAX_BLOCK_TEXT_CHARS)
  .regex(NO_CONTROL_CHARS, "Text must not contain control characters.");

/**
 * The only markup a `text` block may carry.
 *
 * The editor emits exactly these — Tiptap is configured with no other marks
 * and no other nodes (Decision 7) — so anything else is either a hand-crafted
 * payload or a regression in the editor, and refusing both is cheaper than
 * finding out which.
 *
 * The shape of the check is what makes it safe rather than the list of tags:
 * `[^<>]` cannot match `<`, so **every** `<` in the string must be consumed by
 * one of the tag alternatives in full, angle bracket to angle bracket. There
 * is no position at which an attribute can be smuggled in, because there is no
 * alternative that matches an opening tag without also matching its `>`. An
 * anchor's `href` likewise cannot contain `"`, so it cannot close its own
 * attribute; nor whitespace, which is what refuses the entity-encoded
 * `<a href="https://x&#x22; onclick=&#x22;alert(1)">` shape. The character set
 * it excludes is the same one `SafeUrl` excludes, so the two URL surfaces of a
 * campaign body cannot disagree about what a link may contain.
 *
 * It is case-sensitive on purpose. HTML tag names are not, so folding case
 * here would mean folding it for `href` too, and `HREF`/`Href`/`hREF` are then
 * three more spellings the allow-list has to keep straight. The editor emits
 * lower case; anything else is not the editor.
 *
 * The alternation is unambiguous — no two branches can match at the same
 * position — so there is no backtracking to exploit, whatever the 10 000
 * characters are.
 */
const INLINE_HTML_RE =
  /^(?:[^<>]|<\/?(?:strong|em)>|<br ?\/?>|<a href="(?:https?|mailto):[^\s"'`<>\\]*">|<\/a>)*$/;

/**
 * Opening and closing tags, in order. A fresh object per call, never one
 * shared instance: `matchAll` inherits `lastIndex` from a `/g` regex, so a
 * single `.test()` elsewhere would make this silently start scanning
 * mid-string (the lesson `template.ts` records for its placeholder pattern).
 */
const inlineTags = () => /<(\/?)(strong|em|a)\b/g;

/**
 * Every tag opened is closed, in order, and no anchor nests inside another.
 *
 * `INLINE_HTML_RE` is a token allow-list and a token allow-list has nothing to
 * say about structure — it happily admits `text <a href="https://x">no close`.
 * That matters here more than it would in most validators, because the
 * renderer injects this string **unescaped** into a document that continues
 * after it: an unclosed `<a>` swallows every following block into one link,
 * and an unclosed `<strong>` bolds the rest of the message. A nested anchor is
 * refused for a quieter version of the same problem — every HTML parser
 * auto-closes it, so what is stored and what is rendered stop agreeing.
 */
function isWellNested(html: string): boolean {
  const open: string[] = [];
  for (const m of html.matchAll(inlineTags())) {
    const tag = m[2] as string;
    if (m[1] === "/") {
      if (open.pop() !== tag) return false;
    } else {
      if (tag === "a" && open.includes("a")) return false;
      open.push(tag);
    }
  }
  return open.length === 0;
}

const InlineHtml = z
  .string()
  .max(MAX_BLOCK_TEXT_CHARS)
  .regex(NO_CONTROL_CHARS, "Text must not contain control characters.")
  .regex(
    INLINE_HTML_RE,
    "Only bold, italic, line breaks and http(s)/mailto links are allowed here.",
  )
  .refine(isWellNested, "Every tag must be closed, and links must not nest.");

/** One of three sizes; the renderer maps each to a fixed style. */
export const HeadingBlock = z.object({
  kind: z.literal("heading"),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  text: BlockText,
});
export type HeadingBlock = z.infer<typeof HeadingBlock>;

/** A paragraph. The one block whose value reaches the email as markup. */
export const TextBlock = z.object({
  kind: z.literal("text"),
  html: InlineHtml,
});
export type TextBlock = z.infer<typeof TextBlock>;

/** A call to action: label plus destination, rendered as a bulletproof button. */
export const ButtonBlock = z.object({
  kind: z.literal("button"),
  label: BlockText.max(200),
  url: SafeUrl,
});
export type ButtonBlock = z.infer<typeof ButtonBlock>;

export const ImageBlock = z.object({
  kind: z.literal("image"),
  url: SafeUrl,
  /**
   * Required, not optional. An image with no alt text is invisible to a screen
   * reader and to every client that blocks images by default — which is most
   * of them, on first open.
   */
  alt: BlockText.max(300),
  /** Optional wrapping link. */
  href: SafeUrl.optional(),
});
export type ImageBlock = z.infer<typeof ImageBlock>;

/** A horizontal rule. Carries nothing, so there is nothing to validate. */
export const DividerBlock = z.object({ kind: z.literal("divider") });
export type DividerBlock = z.infer<typeof DividerBlock>;

/** Vertical whitespace, in pixels. Bounded so one block cannot be a page. */
export const SpacerBlock = z.object({
  kind: z.literal("spacer"),
  size: z.number().int().min(4).max(96),
});
export type SpacerBlock = z.infer<typeof SpacerBlock>;

/**
 * One block of a campaign body, discriminated on `kind`.
 *
 * A discriminated union rather than a loose object: an unknown `kind` is a
 * refusal naming the field, not a block the renderer silently drops on its way
 * to thousands of inboxes.
 */
export const CampaignBlock = z.discriminatedUnion("kind", [
  HeadingBlock,
  TextBlock,
  ButtonBlock,
  ImageBlock,
  DividerBlock,
  SpacerBlock,
]);
export type CampaignBlock = z.infer<typeof CampaignBlock>;

/** A whole campaign body: at least one block, at most `MAX_BLOCKS`. */
const Blocks = z
  .array(CampaignBlock)
  .min(1, "A campaign needs at least one block.")
  .max(MAX_BLOCKS, `A campaign may have at most ${MAX_BLOCKS} blocks.`);

/**
 * Trimmed before the control-character check, and the check runs on the
 * trimmed value: a whitespace-only subject must fail `min(1)` rather than
 * reach the MIME message as a blank header. Same ordering, and the same two
 * imported rules, as `SendEmailInput`: `MAX_SUBJECT_CHARS` and
 * `NO_CONTROL_CHARS` both come from `template.ts` rather than being restated,
 * so a campaign subject cannot be judged more loosely than an API one.
 */
const Subject = z
  .string()
  .trim()
  .min(1, "Subject is required.")
  .max(MAX_SUBJECT_CHARS)
  .regex(
    NO_CONTROL_CHARS,
    "Subject must not contain line breaks or control characters.",
  );

/**
 * `POST /campaigns` — a draft. Nothing here schedules or sends; a campaign is
 * created in `draft` and moved on by `ScheduleCampaignInput`.
 *
 * `bookId` and `domainId` are shape-checked only. Whether they exist, and
 * whether they belong to the caller's team, is a question for the service —
 * a contract that answered it would be lying about what it can see.
 */
export const CreateCampaignInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(MAX_CAMPAIGN_NAME_CHARS),
  /** The contact book the audience is drawn from. */
  bookId: z.string().trim().min(1).max(64),
  /** The verified sending domain `from` must belong to. */
  domainId: z.string().trim().min(1).max(64),
  from: EmailAddressField,
  replyTo: EmailAddressField.optional(),
  subject: Subject,
  blocks: Blocks,
});
export type CreateCampaignInput = z.infer<typeof CreateCampaignInput>;

/**
 * `PATCH /campaigns/:id`. Every field optional, every check identical.
 *
 * Written out rather than `.partial()` so a reader can see the subject rule
 * did not quietly weaken on the update path — that asymmetry has let bad
 * values in before. `replyTo: null` clears it; omitting it leaves it alone.
 */
export const UpdateCampaignInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(MAX_CAMPAIGN_NAME_CHARS)
    .optional(),
  bookId: z.string().trim().min(1).max(64).optional(),
  domainId: z.string().trim().min(1).max(64).optional(),
  from: EmailAddressField.optional(),
  replyTo: EmailAddressField.nullable().optional(),
  subject: Subject.optional(),
  blocks: Blocks.optional(),
});
export type UpdateCampaignInput = z.infer<typeof UpdateCampaignInput>;

/**
 * Moves a draft to `scheduled`, or straight to `sending` when `scheduledAt` is
 * absent. Offset-bearing, like every other timestamp the API accepts, so
 * "10:00" never means two different instants to two callers.
 */
export const ScheduleCampaignInput = z.object({
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
});
export type ScheduleCampaignInput = z.infer<typeof ScheduleCampaignInput>;

/**
 * Per-campaign tallies.
 *
 * Derived from `emails`/`email_events` and cached on the row, never
 * incremented per event (Decision 8): an incremented counter drifts the first
 * time a webhook retries or a worker dies mid-update, and a stats page that
 * disagrees with the mail log is worse than one that takes a second to load.
 */
export const CampaignCounts = z.object({
  recipients: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  opened: z.number().int().nonnegative(),
  clicked: z.number().int().nonnegative(),
  unsubscribed: z.number().int().nonnegative(),
  bounced: z.number().int().nonnegative(),
  complained: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type CampaignCounts = z.infer<typeof CampaignCounts>;

/** A campaign as the API returns it. */
export const PublicCampaign = z.object({
  id: z.string(),
  name: z.string(),
  bookId: z.string(),
  domainId: z.string(),
  from: z.string(),
  replyTo: z.string().nullable(),
  subject: z.string(),
  blocks: z.array(CampaignBlock),
  status: z.enum(CAMPAIGN_STATUSES),
  scheduledAt: z.iso.datetime().nullable(),
  /** When the fan-out finished, not when it started. */
  sentAt: z.iso.datetime().nullable(),
  counts: CampaignCounts,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PublicCampaign = z.infer<typeof PublicCampaign>;

/**
 * What the audience card shows before anyone commits to sending.
 *
 * The four numbers are deliberately all four: `eligible` is the only one that
 * will actually be mailed, and showing it alone invites "why is it lower than
 * my contact count?". `subscribed` is consent, `suppressed` is deliverability,
 * and Phase 6 Decision 5 keeps them separate everywhere except this
 * intersection — so this is the one screen that has to explain both.
 */
export const AudiencePreview = z.object({
  contacts: z.number().int().nonnegative(),
  subscribed: z.number().int().nonnegative(),
  suppressed: z.number().int().nonnegative(),
  /** Subscribed **and** not suppressed. Both, never either. */
  eligible: z.number().int().nonnegative(),
});
export type AudiencePreview = z.infer<typeof AudiencePreview>;
