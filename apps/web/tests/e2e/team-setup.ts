import { expect, type Page } from "@playwright/test";

/**
 * Walk the connect wizard for whichever team is currently active.
 *
 * Setup is per team: every new team connects its own AWS account, so a spec
 * that creates a team is held on /setup until it does. Before that change the
 * instance was set up once and every later team landed straight in the
 * dashboard, which is why the specs never needed this.
 *
 * A no-op when the team is already set up, so it is safe to call
 * unconditionally after creating one.
 *
 * The server runs with AWS_E2E_MOCK=1, so the keys below are never checked;
 * `src/lib/aws/fake-client.ts` answers for SES/SNS/STS.
 */
export async function completeTeamSetup(page: Page): Promise<void> {
  await page.goto("/setup");
  const manual = page.getByRole("button", { name: "Paste keys manually" });
  const connected = page.getByText("AWS is connected");
  const done = page.getByRole("button", { name: "Go to dashboard" });
  await expect(manual.or(connected).or(done)).toBeVisible();

  if (await manual.isVisible()) {
    await manual.click();
    await page.selectOption("#region", "us-east-1");
    await page.fill("#accessKeyId", "AKIAE2EEXAMPLE0001");
    await page.fill("#secretAccessKey", "e2e-secret-e2e-secret");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    // A successful connect refreshes /setup, which then lands on the first
    // unfinished step — production access, since the fake reports sandbox.
    await expect(
      page.getByRole("heading", { name: "SES production access" }),
    ).toBeVisible();
  }

  // Skip production access and Cloudflare; neither is needed to reach the
  // dashboard, and both are exercised properly in setup.spec.ts.
  //
  // Each step is awaited before the next is probed: an `isVisible()` taken
  // while the previous step is still navigating reads false and silently
  // skips the click.
  const skipProduction = page.getByRole("button", { name: "Skip for now" });
  if (await skipProduction.isVisible()) {
    await skipProduction.click();
    await expect(page).toHaveURL(/step=cloudflare/);
  }

  // With a Cloudflare OAuth client configured the step offers Connect/Skip;
  // without one (the default, and CI) it is informational with a Continue.
  const skip = page.getByRole("button", { name: "Skip", exact: true });
  const carryOn = page.getByRole("link", { name: "Continue", exact: true });
  const finish = page.getByRole("button", { name: "Go to dashboard" });
  if (!(await finish.isVisible())) {
    await expect(skip.or(carryOn)).toBeVisible();
    await ((await skip.isVisible()) ? skip : carryOn).click();
    await expect(page).toHaveURL(/step=done/);
  }

  await finish.click();
  await expect(page).toHaveURL(/\/app$/);
}
