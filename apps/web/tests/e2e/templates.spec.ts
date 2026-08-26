import { expect, test, type Page } from "@playwright/test";
import { completeTeamSetup } from "./team-setup";

// Runs after setup.spec.ts (project `app`), so the dashboard is open. Nothing
// here needs AWS or the worker: a template is created, previewed, versioned,
// restored and deleted entirely inside the app.

/** A fresh owner with their own team, so the templates list starts empty. */
async function signUpOwner(page: Page, label: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto("/signup");
  await page.fill("#name", "Templates");
  await page.fill("#email", `${label}-${suffix}@example.com`);
  await page.fill("#password", "correct-horse-battery");
  await page.click("button[type=submit]");
  const createTeam = page.getByRole("button", { name: "Create team" });
  const checklist = page.getByText("Setup checklist");
  await expect(createTeam.or(checklist)).toBeVisible();
  if (await createTeam.isVisible()) {
    await page.fill("#name", `Templates ${suffix}`);
    await createTeam.click();
    // Team creation is a server action; the new team then lands on /setup
    // (unconnected) or /app. Either way, wait for it to leave /teams/new.
    await page.waitForURL(/\/(setup|app)/);
  }
  // Setup is per team now: a freshly created team is held on /setup until it
  // connects its own AWS account.
  await completeTeamSetup(page);
}

test("create a template, preview it, version it, restore it and delete it", async ({
  page,
}) => {
  await signUpOwner(page, "templates");

  await page.goto("/app/templates");
  await expect(page.getByText("No templates yet")).toBeVisible();

  await page.getByRole("link", { name: "New template" }).first().click();
  await page.fill("#tpl-name", "Welcome mail");
  await page.fill("#tpl-subject", "Hi {{name}}");
  await page.fill("#tpl-html", "<p>Hi {{name}}, welcome.</p>");

  // An undeclared placeholder is the warning that matters: every send that
  // omits it is refused, and the editor says so before the template is saved.
  const undeclared = page.getByRole("alert").filter({ hasText: "name" });
  await expect(undeclared).toBeVisible();
  await page.getByRole("button", { name: "Declare the 1 missing" }).click();
  await expect(undeclared).toHaveCount(0);

  // The preview renders through the same renderer a send uses, inside a
  // sandboxed frame. With a default declared, it shows the default.
  await page.fill("#var-default-0", "Ada");
  await expect(page.getByText("Hi Ada")).toBeVisible();
  const preview = page.frameLocator('iframe[title="Template preview"]');
  await expect(preview.locator("body")).toContainText("Hi Ada, welcome.");

  // The slug is derived from the name when the field is left blank.
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL("**/app/templates/welcome-mail");
  await expect(page.getByText("v1", { exact: true }).first()).toBeVisible();

  // An edit is unsaved until it is saved, and saving cuts a version.
  await page.fill("#tpl-subject", "Hello {{name}}");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByText("Version history")).toBeVisible();
  await expect(page.getByText("v2", { exact: true }).first()).toBeVisible();

  // Restoring v1 puts the old subject back and appends v3 — history is
  // append-only, so the restore is itself undoable.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Restore" }).last().click();
  await expect(page.locator("#tpl-subject")).toHaveValue("Hi {{name}}");
  await expect(page.getByText("v3", { exact: true }).first()).toBeVisible();

  await page.goto("/app/templates");
  await expect(page.getByRole("cell", { name: "Welcome mail" })).toBeVisible();

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No templates yet")).toBeVisible();
});
