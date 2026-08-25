import { describe, expect, it } from "vitest";
import {
  AddSuppressionInput,
  ApiKeyObject,
  CreateApiKeyInput,
  CreateDomainInput,
  CreateWebhookInput,
  DomainObject,
  EMAIL_EVENT_TYPES,
  EmailEventObject,
  PageQuery,
  PatchEmailInput,
  SendStatsObject,
  SuppressionObject,
  UpdateWebhookInput,
  WebhookObject,
} from "../src/index";

describe("shared REST contracts", () => {
  it("CreateDomainInput lowercases and rejects non-hostnames", () => {
    expect(CreateDomainInput.parse({ name: " Mail.Example.com. " })).toEqual({
      name: "mail.example.com",
    });
    expect(CreateDomainInput.safeParse({ name: "not a host" }).success).toBe(
      false,
    );
    expect(CreateDomainInput.safeParse({ name: "localhost" }).success).toBe(
      false,
    );
  });

  it("CreateApiKeyInput defaults permission and drops empty domainId", () => {
    expect(CreateApiKeyInput.parse({ name: " k " })).toEqual({
      name: "k",
      permission: "full",
    });
    // No transforms (OpenAPI): an empty domainId is the caller's problem.
    expect(
      CreateApiKeyInput.safeParse({ name: "k", domainId: "" }).success,
    ).toBe(false);
  });

  it("CreateWebhookInput requires https and at least one known event", () => {
    expect(
      CreateWebhookInput.safeParse({
        url: "http://x.io/h",
        events: ["email.sent"],
      }).success,
    ).toBe(false);
    expect(
      CreateWebhookInput.safeParse({ url: "https://x.io/h", events: ["nope"] })
        .success,
    ).toBe(false);
    expect(
      CreateWebhookInput.parse({
        url: "https://x.io/h",
        events: ["email.sent", "email.sent"],
      }),
    ).toEqual({ url: "https://x.io/h", events: ["email.sent"] });
    expect(UpdateWebhookInput.safeParse({}).success).toBe(false);
    expect(UpdateWebhookInput.parse({ enabled: false })).toEqual({
      enabled: false,
    });
  });

  it("AddSuppressionInput accepts manual/unsubscribe only", () => {
    expect(AddSuppressionInput.parse({ email: "A@b.io" })).toEqual({
      email: "a@b.io",
      reason: "manual",
    });
    expect(
      AddSuppressionInput.safeParse({ email: "a@b.io", note: "" }).success,
    ).toBe(false);
    expect(
      AddSuppressionInput.safeParse({ email: "a@b.io", reason: "bounce" })
        .success,
    ).toBe(false);
  });

  it("PatchEmailInput needs an ISO scheduledAt", () => {
    expect(PatchEmailInput.safeParse({ scheduledAt: "soon" }).success).toBe(
      false,
    );
    expect(PatchEmailInput.safeParse({}).success).toBe(false);
    expect(
      PatchEmailInput.parse({ scheduledAt: "2030-01-01T00:00:00.000Z" }),
    ).toEqual({
      scheduledAt: "2030-01-01T00:00:00.000Z",
    });
  });

  it("PageQuery bounds limit and passes cursor through", () => {
    expect(PageQuery.parse({})).toEqual({ limit: 25 });
    expect(PageQuery.parse({ limit: "10", cursor: "c" })).toEqual({
      limit: 10,
      cursor: "c",
    });
    expect(PageQuery.safeParse({ limit: 500 }).success).toBe(false);
  });

  it("EmailEventObject.type is the closed event enum", () => {
    expect(EMAIL_EVENT_TYPES).toContain("delivered");
    expect(
      EmailEventObject.safeParse({
        id: "e",
        type: "nope",
        occurredAt: "x",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("output objects reject a missing or non-ISO createdAt", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const rec = {
      kind: "DKIM",
      type: "CNAME",
      name: "n",
      value: "v",
      priority: null,
      ok: false,
    };
    const domain = {
      id: "d",
      name: "a.io",
      status: "pending",
      dnsMode: "manual",
      region: "r",
      records: [rec],
      lastError: null,
      verifiedAt: null,
    };
    expect(DomainObject.safeParse(domain).success).toBe(false);
    expect(
      DomainObject.safeParse({ ...domain, createdAt: "yesterday" }).success,
    ).toBe(false);
    const key = {
      id: "k",
      name: "n",
      permission: "full",
      keyPrefix: "p",
      domainId: null,
      lastUsedAt: null,
    };
    expect(ApiKeyObject.safeParse(key).success).toBe(false);
    expect(
      ApiKeyObject.safeParse({ ...key, createdAt: at, lastUsedAt: "x" })
        .success,
    ).toBe(false);
    const hook = {
      id: "w",
      url: "https://x.io",
      events: ["email.sent"],
      enabled: true,
      disabledReason: null,
      failingSince: null,
      updatedAt: at,
    };
    expect(WebhookObject.safeParse(hook).success).toBe(false);
    expect(
      WebhookObject.safeParse({ ...hook, createdAt: at, events: ["nope"] })
        .success,
    ).toBe(false);
    const sup = {
      id: "s",
      email: "a@b.io",
      reason: "manual",
      note: null,
      sourceEmailId: null,
    };
    expect(SuppressionObject.safeParse(sup).success).toBe(false);
    expect(
      SuppressionObject.safeParse({ ...sup, createdAt: at, reason: "x" })
        .success,
    ).toBe(false);
    expect(
      SendStatsObject.safeParse({
        sent: { today: 1, d7: 2, d30: 3 },
        rates: { delivered: 1, bounced: 0, complained: 0 },
      }).success,
    ).toBe(false);
  });

  it("output objects parse the public views", () => {
    expect(
      DomainObject.safeParse({
        id: "d",
        name: "a.io",
        status: "pending",
        dnsMode: "manual",
        region: "us-east-1",
        records: [
          {
            kind: "DKIM",
            type: "CNAME",
            name: "n",
            value: "v",
            priority: null,
            ok: false,
          },
        ],
        lastError: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        verifiedAt: null,
      }).success,
    ).toBe(true);
    expect(
      ApiKeyObject.safeParse({
        id: "k",
        name: "n",
        permission: "full",
        keyPrefix: "ss_live_ab",
        domainId: null,
        lastUsedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      WebhookObject.safeParse({
        id: "w",
        url: "https://x.io",
        events: ["email.sent"],
        enabled: true,
        disabledReason: null,
        failingSince: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      SuppressionObject.safeParse({
        id: "s",
        email: "a@b.io",
        reason: "manual",
        note: null,
        sourceEmailId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      SendStatsObject.safeParse({
        sent: { today: 1, d7: 2, d30: 3 },
        rates: { delivered: 1, bounced: 0, complained: 0 },
        alerts: [],
      }).success,
    ).toBe(true);
  });
});
