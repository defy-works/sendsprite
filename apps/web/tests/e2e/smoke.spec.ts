import { expect, test, type Page } from "@playwright/test";
import { completeTeamSetup } from "./team-setup";

/** A fresh account with a team of the given name, sitting on the dashboard. */
async function signUpWithTeam(page: Page, teamName: string) {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await page.goto("/signup");
  await page.fill("#name", "E2E");
  await page.fill("#email", email);
  await page.fill("#password", "correct-horse-battery");
  await page.click("button[type=submit]");
  const createTeam = page.getByRole("button", { name: "Create team" });
  const checklist = page.getByText("Setup checklist");
  await expect(createTeam.or(checklist)).toBeVisible();
  if (await createTeam.isVisible()) {
    await page.fill("#name", teamName);
    await createTeam.click();
    await page.waitForURL(/\/(setup|app)/);
  }
  await completeTeamSetup(page);
}

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

  // Every dashboard page shows the running version, and /api/health reports
  // the same one.
  const health = await page.request.get("/api/health");
  expect(health.ok()).toBeTruthy();
  const body = await health.json();
  await expect(page.getByRole("contentinfo")).toContainText(
    `Sendsprite ${body.version}`,
  );

  // Settings' pages live in the app's sidebar, under Settings — the page used
  // to grow a second navigation column of its own beside it.
  const sections = page.getByRole("navigation", { name: "Sections" });
  const members = sections.getByRole("link", { name: "Members" });
  await expect(members).toHaveAttribute("href", "/app/settings/members");
  await expect(
    page.getByRole("navigation", { name: "Settings sections" }),
  ).toHaveCount(0);

  // The current sub-page is marked, and only it — the section row above must
  // not claim to be the current page as well.
  await members.click();
  await expect(page).toHaveURL(/\/app\/settings\/members$/);
  await expect(members).toHaveAttribute("aria-current", "page");
  await expect(
    sections.getByRole("link", { name: "Settings", exact: true }),
  ).not.toHaveAttribute("aria-current", "page");

  // The rail collapses to icons and stays collapsed, and the label survives as
  // the row's accessible name.
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  const expand = page.getByRole("button", { name: "Expand sidebar" });
  await expect(expand).toBeVisible();
  await expect(sections.getByRole("link", { name: "Emails" })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Expand sidebar" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "Collapse sidebar" }),
  ).toBeVisible();
});

test("the type-to-confirm gate does not care about case", async ({ page }) => {
  await signUpWithTeam(page, "lower case team");
  await page.goto("/app/settings");

  // The label that names the phrase is styled uppercase, so what a reader sees
  // is not what the team is called. Typing what they see has to work — it did
  // not, and nothing said why.
  await page.getByRole("button", { name: "Delete this team" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Delete this team" });
  await expect(confirm).toBeDisabled();

  await dialog.locator("#confirm-gate").fill("LOWER CASE TEAM");
  await expect(confirm).toBeEnabled();
  // And a name that is simply wrong is still refused.
  await dialog.locator("#confirm-gate").fill("some other team");
  await expect(confirm).toBeDisabled();
});
