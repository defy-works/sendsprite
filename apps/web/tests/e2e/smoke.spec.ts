import { expect, test } from "@playwright/test";

test("signup → create team → shell renders → settings rename", async ({
  page,
}) => {
  // Unique per run: the dev database persists between runs.
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await page.goto("/signup");
  await page.fill("#name", "E2E");
  await page.fill("#email", email);
  await page.fill("#password", "correct-horse-battery");
  await page.click("button[type=submit]");

  // Signup pushes to /app; a user without a team is then server-redirected to
  // /teams/new. The URL passes through /app transiently, so wait for content
  // rather than the URL: either the create-team form or the app shell.
  const createTeam = page.getByRole("button", { name: "Create team" });
  const checklist = page.getByText("Setup checklist");
  await expect(createTeam.or(checklist)).toBeVisible({ timeout: 30_000 });
  if (await createTeam.isVisible()) {
    await page.fill("#name", "Acme");
    await createTeam.click();
    await page.waitForURL("**/app");
  }
  await expect(checklist).toBeVisible();

  await page.goto("/app/settings");
  await page.fill("#team-name", "Acme Renamed");
  await page.getByRole("button", { name: "Save" }).click();
  // The rename revalidates the shell: header title and team switcher update.
  await expect(page.getByRole("banner")).toContainText("Acme Renamed");

  const health = await page.request.get("/api/health");
  expect(health.ok()).toBeTruthy();
});
