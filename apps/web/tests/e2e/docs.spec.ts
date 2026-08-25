import { expect, test, type Page } from "@playwright/test";

/** `--scalar-loaded-api-reference` — set by Scalar's stylesheet, and only by it. */
const loadedMarker = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--scalar-loaded-api-reference")
      .trim(),
  );

test("docs pages render and the OpenAPI document is served", async ({
  page,
}) => {
  await page.goto("/docs");
  await expect(
    page.getByRole("heading", { level: 1, name: /getting started/i }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Docs", exact: true })
    .getByRole("link", { name: "Webhooks" })
    .click();
  await expect(page.getByText("sendsprite-signature").first()).toBeVisible();

  const spec = await page.request.get("/api/v1/openapi.json");
  expect(spec.ok()).toBe(true);
  expect(((await spec.json()) as { openapi: string }).openapi).toBe("3.1.0");

  // Scalar's stylesheet is a full CSS reset. It is scoped to the `(reference)`
  // route group precisely so it cannot reach the prose pages; the marker it
  // sets on `:root` is how we can tell it did not.
  expect(await loadedMarker(page)).toBe("");
});

test("the API reference renders with the network cut off", async ({
  page,
  baseURL,
}) => {
  // The whole pitch is self-hosting: an instance on a private network or an
  // offline runner must render the reference from its own bundle. Everything
  // that is not this origin is refused, so a CDN fetch cannot silently save
  // the page — and any attempt is recorded.
  const origin = new URL(baseURL ?? "http://localhost").origin;
  const external: string[] = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:"))
      return route.fallback();
    external.push(url);
    return route.abort();
  });

  await page.goto("/docs/api");
  await expect(
    page.getByText("Sendsprite API", { exact: false }).first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText("sendEmail").or(page.getByText("Send an email")).first(),
  ).toBeVisible({ timeout: 20_000 });
  expect(external).toEqual([]);
  expect(await loadedMarker(page)).toBe("true");

  // Not a dead end: the reference links back into the docs.
  await page.getByRole("link", { name: /docs/i }).first().click();
  await expect(
    page.getByRole("heading", { level: 1, name: /getting started/i }),
  ).toBeVisible();
  // The back link is a plain anchor, so this is a real page load and the
  // reference's stylesheet does not follow the reader into the prose pages.
  // (With `next/link` it would: a soft navigation keeps the route CSS.)
  expect(await loadedMarker(page)).toBe("");
});

test("every docs section is reachable from the sidebar", async ({ page }) => {
  const sections = [
    ["Self-hosting", "/docs/self-hosting"],
    ["Domains", "/docs/domains"],
    ["Sending", "/docs/sending"],
    ["API keys", "/docs/api-keys"],
    ["Webhooks", "/docs/webhooks"],
    ["Billing", "/docs/billing"],
    ["SDK", "/docs/sdk"],
    ["CLI", "/docs/cli"],
    ["MCP server", "/docs/mcp"],
  ] as const;
  for (const [name, href] of sections) {
    await page.goto(href);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(
      // Not `exact`: a `soon` badge (none today; Phase 6 adds Templates)
      // becomes part of the entry's accessible name.
      page
        .getByRole("navigation", { name: "Docs", exact: true })
        .getByRole("link", { name }),
    ).toHaveAttribute("href", href);
  }
});
