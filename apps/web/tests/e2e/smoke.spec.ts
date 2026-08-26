import { expect, test } from "@playwright/test";
import { completeTeamSetup } from "./team-setup";

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
  await expect(createTeam.or(checklist)).toBeVisible();
  await expect(page).toHaveURL(/\/(teams\/new|app)$/);
  if (await createTeam.isVisible()) {
    await page.fill("#name", "Acme");
    await createTeam.click();
    // Team creation is a server action; the new team then lands on /setup
    // (unconnected) or /app. Either way, wait for it to leave /teams/new.
    await page.waitForURL(/\/(setup|app)/);
  }
  // Setup is per team now: a freshly created team is held on /setup until it
  // connects its own AWS account.
  await completeTeamSetup(page);
  await expect(checklist).toBeVisible();

  await page.goto("/app/settings");
  await page.fill("#team-name", "Acme Renamed");
  // Scoped to the rename form: the page also carries the per-team Retention
  // form, whose submit button is called Save too.
  const renameForm = page.locator("form", { has: page.locator("#team-name") });
  await renameForm.getByRole("button", { name: "Save" }).click();
  // No error alert from the server action (scoped to the form: Next's dev
  // overlay keeps an empty role=alert live region on every page), and the
  // revalidated shell shows the new name.
  await expect(renameForm.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("banner")).toContainText("Acme Renamed");

  // AGPL section 13: every dashboard page offers the source, next to the
  // version it is offering the source *of*, and /api/health says the same.
  const health = await page.request.get("/api/health");
  expect(health.ok()).toBeTruthy();
  const body = await health.json();
  const offer = page.getByRole("contentinfo");
  await expect(offer).toContainText(`Sendsprite ${body.version}`);
  await expect(offer.getByRole("link", { name: "Source" })).toHaveAttribute(
    "href",
    body.sourceUrl,
  );
});
