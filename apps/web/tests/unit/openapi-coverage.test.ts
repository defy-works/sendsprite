import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@sendsprite/shared/openapi";

const root = join(process.cwd(), "src/app/api/v1");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) =>
    statSync(join(d, n)).isDirectory()
      ? walk(join(d, n))
      : n === "route.ts"
        ? [join(d, n)]
        : [],
  );

describe("OpenAPI covers every REST route", () => {
  const doc = buildOpenApiDocument({ serverUrl: "http://x" });
  const documented = new Set(Object.keys(doc.paths));
  const files = walk(root);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const path =
      "/" +
      relative(root, file)
        .replace(/\\/g, "/")
        .replace(/\/route\.ts$/, "")
        .replace(/\[(\w+)\]/g, "{$1}");
    if (path === "/openapi.json") continue;
    documented.delete(path);
    const src = readFileSync(file, "utf8");
    const methods = [
      ...src.matchAll(/^export const (GET|POST|PATCH|PUT|DELETE)\b/gm),
    ].map((m) => m[1]!.toLowerCase());
    it(`${path} → ${methods.join(",")}`, () => {
      const entry = (doc.paths as Record<string, Record<string, unknown>>)[
        path
      ];
      expect(entry, `path ${path} missing from OpenAPI`).toBeDefined();
      expect(methods.length).toBeGreaterThan(0);
      for (const m of methods)
        expect(entry![m], `${m.toUpperCase()} ${path}`).toBeDefined();
      expect(
        Object.keys(entry!).sort(),
        `${path} documents methods the route does not export`,
      ).toEqual([...methods].sort());
    });
  }
  it("documents no path that has no route file", () => {
    expect([...documented]).toEqual([]);
  });
});
