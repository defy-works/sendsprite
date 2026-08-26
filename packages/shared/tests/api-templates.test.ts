import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CreateTemplateInput,
  MAX_VARIABLES_JSON_CHARS,
  MAX_VARIABLE_KEYS,
  MAX_VARIABLE_VALUE_CHARS,
  RenderTemplateInput,
  SendEmailInput,
  TemplateObject,
  TemplateVariablesPayload,
  TemplateVariablesSchema,
  UpdateTemplateInput,
  slugifyTemplateName,
} from "../src/index";

describe("CreateTemplateInput", () => {
  it("accepts the minimum and defaults the optional halves", () => {
    const p = CreateTemplateInput.parse({
      slug: "welcome",
      name: "Welcome",
      subject: "Hi {{name}}",
      bodyHtml: "<p>Hi {{name}}</p>",
    });
    expect(p).toMatchObject({
      slug: "welcome",
      variablesSchema: { variables: [] },
    });
    // An absent optional field stays absent — `toMatchObject` in Vitest 4
    // requires the key to exist, so this is asserted rather than listed above.
    expect(p.bodyText).toBeUndefined();
    expect("bodyText" in p).toBe(false);
  });

  it("lower-cases and validates the slug", () => {
    expect(
      CreateTemplateInput.parse({
        slug: "  Welcome-Email ",
        name: "n",
        subject: "s",
        bodyHtml: "b",
      }).slug,
    ).toBe("welcome-email");
    for (const slug of [
      "",
      "a b",
      "UPPER CASE!",
      "-lead",
      "trail-",
      "a".repeat(65),
    ])
      expect(
        CreateTemplateInput.safeParse({
          slug,
          name: "n",
          subject: "s",
          bodyHtml: "b",
        }).success,
      ).toBe(false);
  });

  it("refuses a subject with line breaks even before rendering", () => {
    expect(
      CreateTemplateInput.safeParse({
        slug: "a",
        name: "n",
        subject: "one\ntwo",
        bodyHtml: "b",
      }).success,
    ).toBe(false);
  });

  it("refuses a body that uses more than 500 variables", () => {
    expect(
      CreateTemplateInput.safeParse({
        slug: "a",
        name: "n",
        subject: "s",
        bodyHtml: "{{a}}".repeat(501),
      }).success,
    ).toBe(false);
    expect(
      CreateTemplateInput.safeParse({
        slug: "a",
        name: "n",
        subject: "s",
        bodyHtml: "{{a}}".repeat(500),
      }).success,
    ).toBe(true);
  });

  it("counts occurrences, not distinct names, in every field", () => {
    const base = { slug: "a", name: "n", subject: "s", bodyHtml: "b" };
    for (const field of ["subject", "bodyHtml", "bodyText"] as const)
      expect(
        CreateTemplateInput.safeParse({
          ...base,
          [field]: "{{a}}".repeat(501),
        }).success,
      ).toBe(false);
  });
});

describe("TemplateVariablesSchema", () => {
  it("defaults type and required, and keeps a default value", () => {
    expect(
      TemplateVariablesSchema.parse({
        variables: [{ name: "name", default: "there" }],
      }),
    ).toEqual({
      variables: [
        { name: "name", type: "string", required: true, default: "there" },
      ],
    });
  });

  it("refuses a variable name the renderer could never match", () => {
    for (const name of ["1bad", "a-b", "", "a b"])
      expect(
        TemplateVariablesSchema.safeParse({ variables: [{ name }] }).success,
      ).toBe(false);
    expect(
      TemplateVariablesSchema.safeParse({ variables: [{ name: "user.first" }] })
        .success,
    ).toBe(true);
  });

  it("bounds a declared default by the same cap a supplied value gets", () => {
    const tooLong = "x".repeat(MAX_VARIABLE_VALUE_CHARS + 1);
    expect(
      TemplateVariablesSchema.safeParse({
        variables: [{ name: "a", default: tooLong }],
      }).success,
    ).toBe(false);
  });
});

describe("UpdateTemplateInput", () => {
  it("needs at least one field", () => {
    expect(UpdateTemplateInput.safeParse({}).success).toBe(false);
    expect(UpdateTemplateInput.safeParse({ name: "New" }).success).toBe(true);
  });
});

describe("RenderTemplateInput", () => {
  it("defaults variables to an empty record", () => {
    expect(RenderTemplateInput.parse({})).toEqual({ variables: {} });
  });

  it("accepts a payload a real templated email would carry", () => {
    expect(
      RenderTemplateInput.safeParse({
        variables: {
          name: "Ada",
          user: { firstName: "Ada", plan: "pro" },
          total: 42,
          renewed: true,
          summary: "x".repeat(MAX_VARIABLE_VALUE_CHARS),
        },
      }).success,
    ).toBe(true);
  });
});

describe("TemplateVariablesPayload", () => {
  const message = (v: unknown) =>
    TemplateVariablesPayload.safeParse(v).error?.issues[0]?.message ?? "";

  it("refuses more keys than the cap, counting nested ones", () => {
    const flat = Object.fromEntries(
      Array.from({ length: MAX_VARIABLE_KEYS + 1 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(TemplateVariablesPayload.safeParse(flat).success).toBe(false);
    expect(message(flat)).toMatch(/keys/);

    const nested = {
      a: Object.fromEntries(
        Array.from({ length: MAX_VARIABLE_KEYS }, (_, i) => [`k${i}`, "v"]),
      ),
    };
    expect(TemplateVariablesPayload.safeParse(nested).success).toBe(false);
    expect(message(nested)).toMatch(/keys/);
  });

  it("refuses one value longer than the per-value cap, and says which", () => {
    const payload = {
      ok: "short",
      blob: "x".repeat(MAX_VARIABLE_VALUE_CHARS + 1),
    };
    const r = TemplateVariablesPayload.safeParse(payload);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/at most 2000 characters/);
    expect(r.error?.issues[0]?.path).toEqual(["blob"]);
    // Nested values are bounded too, and the path names the offender.
    const nested = TemplateVariablesPayload.safeParse({
      user: { bio: "x".repeat(MAX_VARIABLE_VALUE_CHARS + 1) },
    });
    expect(nested.success).toBe(false);
    expect(nested.error?.issues[0]?.path).toEqual(["user", "bio"]);
  });

  it("refuses a payload whose serialised size exceeds the cap", () => {
    const each = "x".repeat(MAX_VARIABLE_VALUE_CHARS);
    const keys = Math.ceil(MAX_VARIABLES_JSON_CHARS / MAX_VARIABLE_VALUE_CHARS);
    const payload = Object.fromEntries(
      Array.from({ length: keys }, (_, i) => [`k${i}`, each]),
    );
    expect(JSON.stringify(payload).length).toBeGreaterThan(
      MAX_VARIABLES_JSON_CHARS,
    );
    expect(TemplateVariablesPayload.safeParse(payload).success).toBe(false);
    expect(message(payload)).toMatch(/once serialised/);
  });

  it("refuses a payload that cannot be serialised at all", () => {
    expect(TemplateVariablesPayload.safeParse({ n: 1n }).success).toBe(false);
    expect(message({ n: 1n })).toMatch(/JSON/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(TemplateVariablesPayload.safeParse(circular).success).toBe(false);
  });

  it("does not blow the stack on a deeply nested payload", () => {
    let node: Record<string, unknown> = { leaf: "v" };
    for (let i = 0; i < 20_000; i++) node = { a: node };
    expect(TemplateVariablesPayload.safeParse(node).success).toBe(false);
  });

  it("bounds what a send can carry too", () => {
    const base = { from: "a@b.co", to: "c@d.co", subject: "s", text: "t" };
    expect(
      SendEmailInput.safeParse({
        ...base,
        variables: { blob: "x".repeat(MAX_VARIABLE_VALUE_CHARS + 1) },
      }).success,
    ).toBe(false);
    expect(
      SendEmailInput.safeParse({ ...base, variables: { name: "Ada" } }).success,
    ).toBe(true);
  });
});

describe("TemplateObject", () => {
  it("parses what the REST layer returns", () => {
    expect(
      TemplateObject.safeParse({
        id: "tpl_1",
        slug: "welcome",
        name: "Welcome",
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
        bodyText: null,
        variablesSchema: { variables: [] },
        version: 3,
        updatedBy: null,
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

describe("slugifyTemplateName", () => {
  it("produces a slug the schema accepts", () => {
    expect(slugifyTemplateName("  Welcome Email!  ")).toBe("welcome-email");
    expect(slugifyTemplateName("한글 Only")).toBe("only");
    expect(slugifyTemplateName("!!!")).toBe("");
  });

  it("truncates a long name without leaving a trailing dash", () => {
    const slug = slugifyTemplateName(`${"ab ".repeat(40)}tail`);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-")).toBe(false);
    expect(
      CreateTemplateInput.safeParse({
        slug,
        name: "n",
        subject: "s",
        bodyHtml: "b",
      }).success,
    ).toBe(true);
  });
});

describe("OpenAPI representability", () => {
  it("emits every template schema as JSON Schema in both views", () => {
    for (const schema of [
      CreateTemplateInput,
      UpdateTemplateInput,
      RenderTemplateInput,
      TemplateObject,
    ])
      for (const io of ["input", "output"] as const)
        expect(() =>
          z.toJSONSchema(schema, { unrepresentable: "any", io }),
        ).not.toThrow();
  });
});
