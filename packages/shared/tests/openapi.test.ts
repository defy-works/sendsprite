import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/openapi";

describe("buildOpenApiDocument", () => {
  const doc = buildOpenApiDocument({ serverUrl: "https://mail.example.com" });
  const { schemas } = doc.components;

  it("is OpenAPI 3.1 with bearer auth and the instance as server", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: "https://mail.example.com/api/v1" }]);
    expect(doc.components.securitySchemes.apiKey).toEqual({
      type: "http",
      scheme: "bearer",
    });
    expect(doc.security).toEqual([{ apiKey: [] }]);
    expect(doc.info.version).toBe("1.0.0");
    expect(
      buildOpenApiDocument({ serverUrl: "https://x", version: "9.9.9" }).info
        .version,
    ).toBe("9.9.9");
  });

  it("strips a trailing slash from the server URL", () => {
    expect(
      buildOpenApiDocument({ serverUrl: "https://mail.example.com/" }).servers,
    ).toEqual([{ url: "https://mail.example.com/api/v1" }]);
  });

  it("documents POST /emails with the SendEmailInput schema and every status it returns", () => {
    const op = doc.paths["/emails"].post;
    expect(op.requestBody?.content["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/SendEmailInput",
    });
    expect(Object.keys(op.responses).sort()).toEqual([
      "200",
      "201",
      "400",
      "401",
      "403",
      "409",
      "413",
      "422",
      "429",
      "500",
    ]);
    expect(op.responses["422"]?.description).toBe(
      "domain_not_verified | suppressed_recipient",
    );
    expect(schemas.SendEmailInput.properties?.subject).toBeDefined();
    // Input view: `to` accepts a string or an array (the transform is not
    // applied) and defaulted fields are optional.
    expect(schemas.SendEmailInput.properties?.to?.anyOf).toHaveLength(2);
    expect(schemas.SendEmailInput.required).toContain("to");
    expect(schemas.SendEmailInput.required).not.toContain("cc");
  });

  it("every error response references the shared error envelope", () => {
    expect(
      schemas.ApiError.properties?.error?.properties?.code?.enum,
    ).toContain("rate_limited");
    for (const item of Object.values(doc.paths))
      for (const op of Object.values(item))
        for (const [status, res] of Object.entries(op.responses))
          if (Number(status) >= 400)
            expect(res.content?.["application/json"]?.schema).toEqual({
              $ref: "#/components/schemas/ApiError",
            });
  });

  it("list endpoints share the page envelope", () => {
    const schema =
      doc.paths["/domains"].get.responses["200"]?.content?.["application/json"]
        ?.schema;
    expect(schema).toEqual({ $ref: "#/components/schemas/DomainPage" });
    expect(schemas.DomainPage.properties?.nextCursor).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    expect(schemas.DomainPage.properties?.data?.items).toEqual({
      $ref: "#/components/schemas/DomainObject",
    });
  });

  it("output objects use nullable unions, not optional keys", () => {
    const email = schemas.EmailObject;
    expect(email.properties?.sentAt?.anyOf).toMatchObject([
      { type: "string", format: "date-time" },
      { type: "null" },
    ]);
    expect(email.required).toContain("sentAt");
  });

  it("every $ref points at a component that exists, with no $defs or $id", () => {
    const names = new Set(Object.keys(schemas));
    const text = JSON.stringify(doc);
    for (const m of text.matchAll(/"\$ref":"([^"]+)"/g)) {
      const ref = m[1]!;
      expect(ref.startsWith("#/components/schemas/"), ref).toBe(true);
      expect(names.has(ref.slice("#/components/schemas/".length)), ref).toBe(
        true,
      );
    }
    expect(text).not.toMatch(/"\$defs"|"\$id"|"\$schema"/);
  });

  it("operationIds are unique and every operation is tagged", () => {
    const ops = Object.values(doc.paths).flatMap((item) => Object.values(item));
    const ids = ops.map((op) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const tags = new Set(doc.tags.map((t) => t.name));
    for (const op of ops)
      for (const t of op.tags) expect(tags.has(t)).toBe(true);
  });

  it("is serialisable (no zod internals leak)", () => {
    expect(() => JSON.stringify(doc)).not.toThrow();
    expect(JSON.stringify(doc)).not.toMatch(/"~standard"|_zod/);
  });
});
