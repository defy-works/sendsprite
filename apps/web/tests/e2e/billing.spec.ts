import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { completeTeamSetup } from "./team-setup";

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
  // Email is two-step: the password field appears after "Continue with email".
  await page.click("button[type=submit]");
  await page.fill("#password", "correct-horse-battery");
  await page.click("button[type=submit]");
  const createTeam = page.getByRole("button", { name: "Create team" });
  const checklist = page.getByText("Setup checklist");
  await expect(createTeam.or(checklist)).toBeVisible();
  if (await createTeam.isVisible()) {
    await page.fill("#name", `Billing ${suffix}`);
    await createTeam.click();
    // Team creation is a server action; the new team then lands on /setup
    // (unconnected) or /app. Either way, wait for it to leave /teams/new.
    await page.waitForURL(/\/(setup|app)/);
  }
  // Setup is per team now: a freshly created team is held on /setup until it
  // connects its own AWS account.
  await completeTeamSetup(page);
}

test("settings links to billing; the page shows the Free plan, this period's usage and the catalog", async ({
  page,
}) => {
  await signUpOwner(page, "billing-page");

  // Billing is reached from the sidebar now. It used to be a card on the
  // Settings page whose entire content was a sentence and a link to the page
  // this test is actually about.
  await page.goto("/app/settings");
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Billing" })
    .click();
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

  // A team that has never subscribed has nothing to manage, and nothing to
  // change in a portal it has no customer record in.
  await expect(
    page.getByRole("button", { name: /manage billing/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Change in portal" }),
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

  await expect.poll(() => seen.length).toBeGreaterThan(0);
  expect(seen[0]).toContain("/checkout/prod_pro");
});

/**
 * The fake provider's module-constant signing secret (`services/billing/fake.ts`
 * — its docstring is explicit that one instance signs what another verifies).
 * Restated here rather than imported: Playwright transpiles this spec but not
 * the workspace packages the fake pulls in, and a drift fails loudly as a 403
 * on the delivery below rather than silently passing.
 */
const FAKE_SECRET = "fake-billing-secret";

/** A `subscription.created` delivery, signed the Standard Webhooks way. */
function signedSubscription(data: Record<string, unknown>) {
  const body = JSON.stringify({ type: "subscription.created", data });
  const id = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": createHmac("sha256", FAKE_SECRET)
        .update(`${id}.${timestamp}.${body}`)
        .digest("hex"),
    },
  };
}

test("a subscribed team is sent to the portal, not to a checkout that would refuse", async ({
  page,
  request,
}) => {
  await signUpOwner(page, "billing-subscribed");
  await page.goto("/app/settings/billing");

  // The team id is the provider's external customer id, and the fake puts it
  // in the checkout URL — so one intercepted Choose click is also how this
  // spec learns which team to subscribe.
  const seen: string[] = [];
  await page.route("**fake.billing.test/**", async (route) => {
    seen.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body>fake provider</body></html>",
    });
  });
  await page
    .getByRole("listitem")
    .filter({ hasText: "Sendsprite Pro" })
    .getByRole("button", { name: "Choose" })
    .click();
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  const [checkoutUrl] = seen;
  if (!checkoutUrl) throw new Error("no checkout navigation was intercepted");
  const teamId = new URL(checkoutUrl).searchParams.get("customer");
  expect(teamId).toBeTruthy();

  // Subscribe it the only way production ever does: a verified webhook.
  const start = Date.now();
  const event = signedSubscription({
    subscriptionId: `sub_${randomUUID()}`,
    externalCustomerId: teamId,
    productId: "prod_pro",
    status: "active",
    currentPeriodStart: new Date(start).toISOString(),
    currentPeriodEnd: new Date(start + 30 * 24 * 3600 * 1000).toISOString(),
    modifiedAt: new Date(start).toISOString(),
  });
  const res = await request.post("/api/billing/webhook", {
    headers: event.headers,
    data: event.body,
  });
  expect(res.status()).toBe(200);
  expect((await res.json()) as { applied: boolean }).toMatchObject({
    applied: true,
  });

  await page.goto("/app/settings/billing");
  const pro = page.getByRole("listitem").filter({ hasText: "Sendsprite Pro" });
  await expect(pro.getByText("Current plan")).toBeVisible();

  // The whole point: no tile offers an action `startCheckout` would refuse.
  await expect(page.getByRole("button", { name: "Choose" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Downgrade" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Change in portal" }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: /manage billing/i }),
  ).toBeVisible();

  // And the replacement works: it opens the customer portal.
  seen.length = 0;
  await page
    .getByRole("listitem")
    .filter({ hasText: "Sendsprite Scale" })
    .getByRole("button", { name: "Change in portal" })
    .click();
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  expect(seen[0]).toContain(`/portal/${teamId}`);
});

test("the provider webhook endpoint is mounted and refuses an unsigned delivery", async ({
  request,
}) => {
  // With billing off this route is a bare 404, and every other spec in the
  // suite would see that; here it must exist. It must also refuse: nothing
  // that has not been signature-verified is ever applied, so an unsigned POST
  // is a 403 and not a 200 with `applied: false`.
  const res = await request.post("/api/billing/webhook", {
    data: { type: "subscription.updated", data: {} },
  });
  expect(res.status()).toBe(403);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("forbidden");
});
