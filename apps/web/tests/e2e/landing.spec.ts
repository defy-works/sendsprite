import { expect, test } from "@playwright/test";

// LANDING_ENABLED defaults to true (env.schema.ts) and the instance setting
// is left unset by setup.spec.ts, so "/" renders the landing page here.
test("landing page (LANDING_ENABLED) shows hero, install and docs links", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /email api/i,
  );
  await expect(page.getByText("curl -fsSL")).toBeVisible();
  await page.getByRole("tab", { name: "React" }).click();
  await expect(page.getByText("sendsprite/react")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /read the docs/i }),
  ).toHaveAttribute("href", "/docs");
  await expect(
    page.getByRole("link", { name: /open dashboard|sign in/i }),
  ).toBeVisible();
});

test("code tabs are keyboard operable", async ({ page }) => {
  await page.goto("/");
  const tablist = page.getByRole("tablist", { name: /send an email/i });
  await expect(tablist.getByRole("tab", { name: "curl" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await tablist.getByRole("tab", { name: "CLI" }).focus();
  await page.keyboard.press("Enter");
  await expect(tablist.getByRole("tab", { name: "CLI" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("npx sendsprite login")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(tablist.getByRole("tab", { name: "React" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
