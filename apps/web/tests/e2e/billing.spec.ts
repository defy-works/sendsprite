import { expect, test, type Page } from "@playwright/test";

// Runs after setup.spec.ts (project `app`), so the instance is set up. The
// server has BILLING_ENABLED=1 and BILLING_PROVIDER=fake, so the catalog is
// the fake provider's three-tier mirror of the sandbox and checkout URLs point
// at `fake.billing.test`, which does not resolve.

/** A fresh owner with their own team: every spec here starts unsubscribed. */
async function signUpOwner(page: Page, label: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto("/signup");
  await page.fill("#name", "Billing");
  await page.fill("#email", `${label}-${suffix}@example.com`);
  await page.fill("#password", "correct-horse-battery");
  await page.click("button[type=submit]");
  const createTeam = page.getByRole("button", { name: "Create team" });
  const checklist = page.getByText("Setup checklist");
  await expect(createTeam.or(checklist)).toBeVisible({ timeout: 30_000 });
  if (await createTeam.isVisible()) {
    await page.fill("#name", `Billing ${suffix}`);
    await createTeam.click();
    await page.waitForURL("**/app");
  }
}

test("settings links to billing; the page shows the Free plan, this period's usage and the catalog", async ({
  page,
}) => {
  await signUpOwner(page, "billing-page");

  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  await page.getByRole("link", { name: /open billing/i }).click();
  await expect(page).toHaveURL(/\/app\/settings\/billing$/);

  // Current-plan card: the plan, the allowance and the period meter.
  await expect(page.getByRole("heading", { name: "Your plan" })).toBeVisible();
  await expect(page.getByText(/3,000 included/)).toBeVisible();
  await expect(page.getByText(/capped at the included volume/i)).toBeVisible();
  const meter = page.getByRole("progressbar", {
    name: /emails used this period/i,
  });
  await expect(meter).toBeVisible();
  await expect(meter).toHaveAttribute("aria-valuemax", "3000");

  // Catalog: three tiers, Free marked current, the paid ones actionable.
  await expect(page.getByText("Sendsprite Free")).toBeVisible();
  await expect(page.getByText("Sendsprite Pro")).toBeVisible();
  await expect(page.getByText("Sendsprite Scale")).toBeVisible();
  await expect(page.getByText("$12")).toBeVisible();
  await expect(page.getByText("Current plan")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose" }).first(),
  ).toBeEnabled();

  // A team that has never subscribed has nothing to manage.
  await expect(
    page.getByRole("button", { name: /manage billing/i }),
  ).toHaveCount(0);
});

test("checkout sends the browser to the provider", async ({ page }) => {
  await signUpOwner(page, "billing-checkout");
  await page.goto("/app/settings/billing");

  // The fake provider's checkout URL is off-origin and does not resolve, so
  // it is intercepted; asserting the navigation attempt is what matters, not
  // the destination. The button doing nothing is the regression this catches.
  const seen: string[] = [];
  await page.route("**fake.billing.test/**", async (route) => {
    seen.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body>fake checkout</body></html>",
    });
  });

  await page
    .getByRole("listitem")
    .filter({ hasText: "Sendsprite Pro" })
    .getByRole("button", { name: "Choose" })
    .click();

  await expect.poll(() => seen.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(seen[0]).toContain("/checkout/prod_pro");
});
