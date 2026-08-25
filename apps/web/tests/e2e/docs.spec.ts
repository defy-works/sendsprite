import { expect, test } from "@playwright/test";

test("docs pages and API reference render", async ({ page }) => {
  await page.goto("/docs");
  await expect(
    page.getByRole("heading", { level: 1, name: /getting started/i }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Docs", exact: true })
    .getByRole("link", { name: "Webhooks" })
    .click();
  await expect(page.getByText("sendsprite-signature").first()).toBeVisible();

  await page.goto("/docs/api");
  await expect(
    page.getByText("Sendsprite API", { exact: false }).first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText("sendEmail").or(page.getByText("Send an email")).first(),
  ).toBeVisible({ timeout: 20_000 });

  const spec = await page.request.get("/api/v1/openapi.json");
  expect(spec.ok()).toBe(true);
  expect(((await spec.json()) as { openapi: string }).openapi).toBe("3.1.0");
});

test("every docs section is reachable from the sidebar", async ({ page }) => {
  const sections = [
    ["Self-hosting", "/docs/self-hosting"],
    ["Domains", "/docs/domains"],
    ["Sending", "/docs/sending"],
    ["API keys", "/docs/api-keys"],
    ["Webhooks", "/docs/webhooks"],
    ["SDK", "/docs/sdk"],
    ["CLI", "/docs/cli"],
    ["MCP server", "/docs/mcp"],
  ] as const;
  for (const [name, href] of sections) {
    await page.goto(href);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(
      // Not `exact`: the CLI and MCP entries carry a "soon" badge, which is
      // part of their accessible name.
      page
        .getByRole("navigation", { name: "Docs", exact: true })
        .getByRole("link", { name }),
    ).toHaveAttribute("href", href);
  }
});
