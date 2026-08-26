import { expect, test, type Page } from "@playwright/test";
import { completeTeamSetup } from "./team-setup";
import { acceptConfirm, acceptTypedConfirm } from "./_ui";

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

  // A new template opens in the visual editor — the same one campaigns use.
  // This spec is about placeholders, versions and restores, so it switches to
  // HTML, which is the mode those are easiest to assert in. The designer is
  // covered by its own test below.
  await expect(page.getByRole("radio", { name: "Design" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("radio", { name: "HTML" }).click();
  await acceptConfirm(page, "Switch to HTML");

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
  await expect(page.getByText("Template saved")).toBeVisible();
  await expect(page.getByText("Version history")).toBeVisible();
  await expect(page.getByText("v2", { exact: true }).first()).toBeVisible();

  // Restoring v1 puts the old subject back and appends v3 — history is
  // append-only, so the restore is itself undoable.
  await page.getByRole("button", { name: "Restore" }).last().click();
  await acceptConfirm(page, "Restore v1");
  await expect(page.locator("#tpl-subject")).toHaveValue("Hi {{name}}");
  await expect(page.getByText("v3", { exact: true }).first()).toBeVisible();

  await page.goto("/app/templates");
  await expect(page.getByRole("cell", { name: "Welcome mail" })).toBeVisible();

  await page.getByRole("button", { name: "Delete" }).click();
  // Gated on typing the slug: a live `POST /emails` names a template by slug,
  // so deleting one breaks those sends rather than degrading them.
  await acceptTypedConfirm(page, "Delete template", "welcome-mail");
  await expect(page.getByText("No templates yet")).toBeVisible();
});

test("a template built in the visual editor compiles to its body", async ({
  page,
}) => {
  await signUpOwner(page, "designer");
  await page.goto("/app/templates/new");

  await page.fill("#tpl-name", "Designed");
  await page.fill("#tpl-subject", "Hi {{name}}");

  // The starter is a heading and a paragraph; a button is added from the
  // palette, which is what makes this the campaign editor rather than a
  // textarea with a different label.
  await page
    .locator("li")
    .filter({ has: page.getByText("Heading", { exact: true }) })
    .getByLabel("Text", { exact: true })
    .fill("Welcome, {{name}}");
  await page.getByRole("button", { name: "Add Button", exact: true }).click();
  const button = page
    .locator("li")
    .filter({ has: page.getByText("Button", { exact: true }) });
  await button.getByLabel("Label").fill("Get started");
  await button
    .getByLabel("Links to", { exact: true })
    .fill("https://example.com/start");

  // The preview is the compiled blocks, and it carries the placeholder
  // through — a heading is escaped, and `{{name}}` has nothing to escape.
  const preview = page.frameLocator('iframe[title="Template preview"]');
  await expect(preview.getByRole("heading")).toContainText("Welcome");
  await expect(
    preview.getByRole("link", { name: "Get started" }),
  ).toHaveAttribute("href", "https://example.com/start");

  // A template carries no unsubscribe footer, whichever way it was written:
  // it is the body of a transactional send, not bulk mail to a list.
  await expect(preview.getByText("Unsubscribe")).toHaveCount(0);

  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL("**/app/templates/designed");

  // Reopening shows the blocks, not the HTML they compiled to. That is the
  // whole reason the design is stored beside the body.
  await page.reload();
  await expect(page.getByRole("radio", { name: "Design" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(
    page
      .locator("li")
      .filter({ has: page.getByText("Button", { exact: true }) })
      .getByLabel("Label"),
  ).toHaveValue("Get started");
});
