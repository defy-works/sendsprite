import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/openapi";

/**
 * The templates half of the document. In its own file rather than appended to
 * `openapi.test.ts` because these assertions are about one tag's operations
 * rather than about the emitter, and the contacts routes document a second
 * resource against the same helpers next.
 */
describe("buildOpenApiDocument — templates", () => {
  const doc = buildOpenApiDocument({ serverUrl: "https://mail.example.com" });
  const { schemas } = doc.components;
  const paths = doc.paths as unknown as Record<
    string,
    Record<string, { responses: Record<string, unknown> }>
  >;
  const statuses = (path: string, method: string) =>
    Object.keys(paths[path]?.[method]?.responses ?? {});

  it("documents every templates operation, and only those", () => {
    const expected: Record<string, string[]> = {
      "/templates": ["get", "post"],
      "/templates/{slug}": ["get", "patch", "delete"],
      "/templates/{slug}/render": ["post"],
    };
    for (const [path, methods] of Object.entries(expected)) {
      expect(paths[path], path).toBeDefined();
      expect(Object.keys(paths[path]!).sort()).toEqual([...methods].sort());
    }
    expect(doc.tags.map((t) => t.name)).toEqual(
      expect.arrayContaining(["Templates"]),
    );
  });

  it("names the input and output schemas the routes actually use", () => {
    for (const id of [
      "CreateTemplateInput",
      "UpdateTemplateInput",
      "RenderTemplateInput",
      "TemplateObject",
      "TemplateVersionObject",
      "TemplateDetail",
      "TemplatePage",
      "RenderedTemplateObject",
    ] as const)
      expect(schemas[id], id).toBeDefined();
    // `slug` is create-only: renaming a live template is a create plus a delete.
    expect(schemas.CreateTemplateInput.required).toContain("slug");
    expect(schemas.UpdateTemplateInput.properties?.slug).toBeUndefined();
    // The detail view is the object plus its history, not a separate shape.
    expect(schemas.TemplateDetail.properties?.versions?.items).toEqual({
      $ref: "#/components/schemas/TemplateVersionObject",
    });
  });

  it("lists the statuses each templates operation can return", () => {
    expect(statuses("/templates", "post")).toEqual(
      expect.arrayContaining(["201", "400", "401", "403", "409", "500"]),
    );
    expect(statuses("/templates/{slug}", "delete")).toEqual(
      expect.arrayContaining(["204", "404"]),
    );
    // The render route carries its own body cap, so it can answer 413.
    expect(statuses("/templates/{slug}/render", "post")).toEqual(
      expect.arrayContaining(["200", "400", "404", "413"]),
    );
  });

  it("returns the rendered template, and nothing about the stored row", () => {
    // The render endpoint is a dry run, so it has no side-effect statuses.
    expect(
      doc.paths["/templates/{slug}/render"].post.responses["200"]?.content?.[
        "application/json"
      ]?.schema,
    ).toEqual({ $ref: "#/components/schemas/RenderedTemplateObject" });
    expect(
      Object.keys(schemas.RenderedTemplateObject.properties ?? {}),
    ).toEqual(["subject", "html", "text"]);
  });
});
