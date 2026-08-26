/**
 * The SDK ships hand-written types (`src/types.ts`) so its `.d.ts` has no
 * dependency on the private `@sendsprite/shared` package or on zod. This file
 * pins them to the shared zod contracts:
 *
 * - compile-time: every SDK type must be mutually assignable with the schema
 *   type it mirrors (inputs → `z.input`, response objects → `z.output`), so
 *   `bun run typecheck` fails when either side drifts;
 * - run-time: the enum unions are checked against the shared constant arrays.
 *
 * NOTE: the compile-time half is enforced by `tsc` (root `bun run typecheck`),
 * **not** by vitest. Vitest transpiles without type-checking, so a broken
 * `Checks` tuple still runs green here — the `it()` below only proves the file
 * was reached. Never treat a passing vitest run as parity evidence.
 */
import * as shared from "@sendsprite/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type * as sdk from "../src/types";

/** `any` is assignable both ways, so it would silently satisfy `Mutual`. */
type IsAny<T> = 0 extends 1 & T ? true : false;
/**
 * `true` only when `A` and `B` are mutually assignable *and* neither has
 * degraded to `any` — a shared schema slipping to `z.any()` must fail, not
 * pass vacuously.
 */
type Mutual<A, B> =
  IsAny<A> extends true
    ? false
    : IsAny<B> extends true
      ? false
      : [A] extends [B]
        ? [B] extends [A]
          ? true
          : false
        : false;
type In<S extends z.ZodType> = z.input<S>;
type Out<S extends z.ZodType> = z.output<S>;

// Each entry must be `true`; a mismatch turns the tuple element into `false`
// and the annotation below fails to compile.
type Checks = [
  Mutual<sdk.ErrorCode, shared.ErrorCode>,
  Mutual<sdk.EmailStatus, shared.EmailStatus>,
  Mutual<sdk.EmailEventType, shared.EmailEventType>,
  Mutual<sdk.AttachmentInput, In<typeof shared.AttachmentInput>>,
  Mutual<sdk.SendEmailInput, In<typeof shared.SendEmailInput>>,
  Mutual<sdk.BatchSendInput, In<typeof shared.BatchSendInput>>,
  Mutual<sdk.EmailObject, Out<typeof shared.EmailObject>>,
  Mutual<sdk.EmailEventObject, Out<typeof shared.EmailEventObject>>,
  Mutual<sdk.EmailDetail, Out<typeof shared.EmailDetail>>,
  Mutual<sdk.PatchEmailInput, In<typeof shared.PatchEmailInput>>,
  // `z.coerce.number()` accepts `unknown` on input; the SDK deliberately
  // narrows `limit` to `number`, so compare the parsed (output) shapes.
  Mutual<
    Required<sdk.ListEmailsParams>,
    Required<Out<typeof shared.ListQuery>>
  >,
  Mutual<Required<sdk.PageParams>, Required<Out<typeof shared.PageQuery>>>,
  Mutual<sdk.DomainStatus, shared.DomainStatus>,
  Mutual<sdk.DnsMode, shared.DnsMode>,
  Mutual<sdk.DnsRecordKind, shared.DnsRecordKind>,
  Mutual<sdk.CreateDomainInput, In<typeof shared.CreateDomainInput>>,
  Mutual<sdk.DnsRecordObject, Out<typeof shared.DnsRecordObject>>,
  Mutual<sdk.DomainObject, Out<typeof shared.DomainObject>>,
  Mutual<sdk.ApiKeyPermission, shared.ApiKeyPermission>,
  Mutual<sdk.CreateApiKeyInput, In<typeof shared.CreateApiKeyInput>>,
  Mutual<sdk.ApiKeyObject, Out<typeof shared.ApiKeyObject>>,
  Mutual<sdk.ApiKeyCreated, Out<typeof shared.ApiKeyCreated>>,
  Mutual<sdk.WebhookEventType, shared.WebhookEventType>,
  Mutual<sdk.WebhookPayload, shared.WebhookPayload>,
  Mutual<sdk.CreateWebhookInput, In<typeof shared.CreateWebhookInput>>,
  Mutual<sdk.UpdateWebhookInput, In<typeof shared.UpdateWebhookInput>>,
  Mutual<sdk.WebhookObject, Out<typeof shared.WebhookObject>>,
  Mutual<sdk.WebhookCreated, Out<typeof shared.WebhookCreated>>,
  Mutual<sdk.WebhookTestAccepted, Out<typeof shared.WebhookTestAccepted>>,
  Mutual<sdk.SuppressionReason, shared.SuppressionReason>,
  Mutual<sdk.AddSuppressionInput, In<typeof shared.AddSuppressionInput>>,
  Mutual<sdk.SuppressionObject, Out<typeof shared.SuppressionObject>>,
  Mutual<sdk.SendStatsObject, Out<typeof shared.SendStatsObject>>,
  Mutual<sdk.MeObject, Out<typeof shared.MeObject>>,
  Mutual<sdk.StreamChange, Out<typeof shared.StreamChange>>,
  Mutual<sdk.TemplateVariableType, shared.TemplateVariableType>,
  Mutual<sdk.TemplateVariable, In<typeof shared.TemplateVariable>>,
  // The stored form: `type` has been resolved to its default, so it is
  // required here while it is optional on the way in.
  Mutual<sdk.DeclaredTemplateVariable, Out<typeof shared.TemplateVariable>>,
  Mutual<
    sdk.TemplateVariablesSchema,
    In<typeof shared.TemplateVariablesSchema>
  >,
  Mutual<sdk.CreateTemplateInput, In<typeof shared.CreateTemplateInput>>,
  Mutual<sdk.UpdateTemplateInput, In<typeof shared.UpdateTemplateInput>>,
  Mutual<sdk.TemplateObject, Out<typeof shared.TemplateObject>>,
  Mutual<sdk.TemplateVersionObject, Out<typeof shared.TemplateVersionObject>>,
  Mutual<sdk.TemplateDetail, Out<typeof shared.TemplateDetail>>,
  Mutual<sdk.RenderTemplateInput, In<typeof shared.RenderTemplateInput>>,
  Mutual<sdk.RenderedTemplateObject, Out<typeof shared.RenderedTemplateObject>>,
  Mutual<sdk.CreateContactBookInput, In<typeof shared.CreateContactBookInput>>,
  Mutual<sdk.UpdateContactBookInput, In<typeof shared.UpdateContactBookInput>>,
  Mutual<sdk.ContactBookObject, Out<typeof shared.ContactBookObject>>,
  Mutual<sdk.CreateContactInput, In<typeof shared.CreateContactInput>>,
  Mutual<sdk.UpdateContactInput, In<typeof shared.UpdateContactInput>>,
  Mutual<sdk.ContactObject, Out<typeof shared.ContactObject>>,
  // `limit` is coerced, and `subscribed` is a `"true" | "false"` enum on the
  // wire that parses to a boolean — so compare the parsed (output) shapes.
  Mutual<
    Required<sdk.ListContactsParams>,
    Required<Out<typeof shared.ListContactsQuery>>
  >,
  Mutual<sdk.ImportContactsInput, In<typeof shared.ImportContactsInput>>,
  Mutual<sdk.ImportContactsResult, Out<typeof shared.ImportContactsResult>>,
  Mutual<
    sdk.UnsubscribeContactInput,
    In<typeof shared.UnsubscribeContactInput>
  >,
  Mutual<sdk.UnsubscribeResult, Out<typeof shared.UnsubscribeResult>>,
  Mutual<sdk.CampaignStatus, shared.CampaignStatus>,
  // Blocks appear on both the create body and the returned campaign, and
  // nothing in them defaults or transforms, so `In` and `Out` are the same
  // shape — pinning the input side pins both.
  Mutual<sdk.HeadingBlock, In<typeof shared.HeadingBlock>>,
  Mutual<sdk.TextBlock, In<typeof shared.TextBlock>>,
  Mutual<sdk.ButtonBlock, In<typeof shared.ButtonBlock>>,
  Mutual<sdk.ImageBlock, In<typeof shared.ImageBlock>>,
  Mutual<sdk.DividerBlock, In<typeof shared.DividerBlock>>,
  Mutual<sdk.SpacerBlock, In<typeof shared.SpacerBlock>>,
  Mutual<sdk.LeafBlock, In<typeof shared.LeafBlock>>,
  // A row of columns carries a `superRefine`, so it is not an object schema —
  // `z.input` still resolves, and the column-count rule it adds is a run-time
  // check with no type to mirror.
  Mutual<sdk.ColumnsBlock, In<typeof shared.ColumnsBlock>>,
  Mutual<sdk.CampaignBlock, In<typeof shared.CampaignBlock>>,
  Mutual<sdk.CampaignTheme, In<typeof shared.CampaignTheme>>,
  Mutual<sdk.CreateCampaignInput, In<typeof shared.CreateCampaignInput>>,
  Mutual<sdk.UpdateCampaignInput, In<typeof shared.UpdateCampaignInput>>,
  Mutual<sdk.ScheduleCampaignInput, In<typeof shared.ScheduleCampaignInput>>,
  Mutual<sdk.CampaignCounts, Out<typeof shared.CampaignCounts>>,
  Mutual<sdk.CampaignObject, Out<typeof shared.CampaignObject>>,
  Mutual<sdk.AudiencePreview, Out<typeof shared.AudiencePreview>>,
];
const allTrue: Checks = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];

describe("SDK types mirror @sendsprite/shared", () => {
  it("compile-time parity checks are all true", () => {
    expect(allTrue.every(Boolean)).toBe(true);
  });

  it("enum unions match the shared constant arrays", () => {
    // Exhaustiveness is enforced by the `Record<union, true>` annotations:
    // adding a member to a shared array without adding it here fails typecheck.
    const emailStatus: Record<sdk.EmailStatus, true> = {
      queued: true,
      scheduled: true,
      sending: true,
      sent: true,
      delivered: true,
      bounced: true,
      complained: true,
      failed: true,
      cancelled: true,
    };
    expect(Object.keys(emailStatus).sort()).toEqual(
      [...shared.EMAIL_STATUS].sort(),
    );
    const eventTypes: Record<sdk.EmailEventType, true> = {
      queued: true,
      sent: true,
      delivered: true,
      delivery_delayed: true,
      bounced: true,
      complained: true,
      rejected: true,
      opened: true,
      clicked: true,
      failed: true,
      cancelled: true,
    };
    expect(Object.keys(eventTypes).sort()).toEqual(
      [...shared.EMAIL_EVENT_TYPES].sort(),
    );
    const errorCodes: Record<sdk.ErrorCode, true> = {
      validation_error: true,
      unauthorized: true,
      forbidden: true,
      not_found: true,
      domain_not_verified: true,
      suppressed_recipient: true,
      rate_limited: true,
      daily_quota_exceeded: true,
      monthly_quota_exceeded: true,
      sandbox_restricted: true,
      idempotency_conflict: true,
      conflict: true,
      payload_too_large: true,
      not_configured: true,
      internal_error: true,
    };
    expect(Object.keys(errorCodes).sort()).toEqual(
      [...shared.ERROR_CODES].sort(),
    );
    const webhookEvents: Record<sdk.WebhookEventType, true> = {
      "email.sent": true,
      "email.delivered": true,
      "email.delayed": true,
      "email.bounced": true,
      "email.complained": true,
      "email.opened": true,
      "email.clicked": true,
      "email.failed": true,
      "contact.created": true,
      "contact.updated": true,
      "contact.unsubscribed": true,
      "contact.resubscribed": true,
      "domain.verified": true,
      "domain.failed": true,
      "campaign.sent": true,
      "campaign.completed": true,
    };
    expect(Object.keys(webhookEvents).sort()).toEqual(
      [...shared.WEBHOOK_EVENT_TYPES].sort(),
    );
    const dnsKinds: Record<sdk.DnsRecordKind, true> = {
      DKIM: true,
      MAIL_FROM_MX: true,
      MAIL_FROM_SPF: true,
      DMARC: true,
    };
    expect(Object.keys(dnsKinds).sort()).toEqual(
      [...shared.DNS_RECORD_KINDS].sort(),
    );
    const campaignStatuses: Record<sdk.CampaignStatus, true> = {
      draft: true,
      scheduled: true,
      sending: true,
      sent: true,
      cancelled: true,
    };
    expect(Object.keys(campaignStatuses).sort()).toEqual(
      [...shared.CAMPAIGN_STATUSES].sort(),
    );
    const blockAlignments: Record<sdk.BlockAlign, true> = {
      left: true,
      center: true,
      right: true,
    };
    expect(Object.keys(blockAlignments).sort()).toEqual(
      [...shared.BLOCK_ALIGNMENTS].sort(),
    );
    const cornerStyles: Record<sdk.CornerStyle, true> = {
      sharp: true,
      soft: true,
      pill: true,
    };
    expect(Object.keys(cornerStyles).sort()).toEqual(
      [...shared.CORNER_STYLES].sort(),
    );
    const columnLayouts: Record<sdk.ColumnLayout, true> = {
      "1-1": true,
      "1-1-1": true,
      "2-1": true,
      "1-2": true,
    };
    expect(Object.keys(columnLayouts).sort()).toEqual(
      [...shared.COLUMN_LAYOUTS].sort(),
    );
    const fontFamilies: Record<sdk.FontFamily, true> = {
      sans: true,
      serif: true,
      mono: true,
    };
    expect(Object.keys(fontFamilies).sort()).toEqual(
      [...shared.FONT_FAMILIES].sort(),
    );
    // Numeric unions, so `Record<union, true>` keys come back as strings.
    const imageWidths: Record<sdk.ImageWidth, true> = {
      25: true,
      50: true,
      75: true,
      100: true,
    };
    expect(Object.keys(imageWidths).map(Number).sort()).toEqual(
      [...shared.IMAGE_WIDTHS].sort(),
    );
    const contentWidths: Record<sdk.ContentWidth, true> = {
      480: true,
      600: true,
      720: true,
    };
    expect(Object.keys(contentWidths).map(Number).sort()).toEqual(
      [...shared.CONTENT_WIDTHS].sort(),
    );
    const variableTypes: Record<sdk.TemplateVariableType, true> = {
      string: true,
      number: true,
      boolean: true,
    };
    expect(Object.keys(variableTypes).sort()).toEqual(
      [...shared.TEMPLATE_VARIABLE_TYPES].sort(),
    );
  });
});
