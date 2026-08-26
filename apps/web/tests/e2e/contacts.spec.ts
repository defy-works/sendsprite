import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { completeTeamSetup } from "./team-setup";
import { acceptConfirm, acceptTypedConfirm } from "./_ui";

// Runs after setup.spec.ts (project `app`), so the dashboard is open. Nothing
// here needs AWS or the worker: a book, its contacts, an import and an export
// happen entirely inside the app.

/** A fresh owner with their own team, so the contacts list starts empty. */
async function signUpOwner(page: Page, label: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto("/signup");
  await page.fill("#name", "Contacts");
  await page.fill("#email", `${label}-${suffix}@example.com`);
  await page.fill("#password", "correct-horse-battery");
  await page.click("button[type=submit]");
  const createTeam = page.getByRole("button", { name: "Create team" });
  const checklist = page.getByText("Setup checklist");
  await expect(createTeam.or(checklist)).toBeVisible();
  if (await createTeam.isVisible()) {
    await page.fill("#name", `Contacts ${suffix}`);
    await createTeam.click();
    // Team creation is a server action; the new team then lands on /setup
    // (unconnected) or /app. Either way, wait for it to leave /teams/new.
    await page.waitForURL(/\/(setup|app)/);
  }
  // Setup is per team now: a freshly created team is held on /setup until it
  // connects its own AWS account.
  await completeTeamSetup(page);
}

/**
 * The import fixture. The first row is the one that matters: a "first name"
 * that a spreadsheet would execute on open, which has to come back from the
 * export escaped.
 */
const CSV = [
  "email,first_name,plan",
  'ada@example.com,"=HYPERLINK(""http://evil.test"")",pro',
  "grace@example.com,Grace,free",
  "",
].join("\n");

test("create a book, manage its contacts, import a CSV and export it safely", async ({
  page,
}) => {
  await signUpOwner(page, "contacts");

  await page.goto("/app/contacts");
  await expect(page.getByText("No contact books")).toBeVisible();
  // The distinction the empty state exists to teach.
  await expect(page.getByText("suppression list").first()).toBeVisible();

  await page.fill("#book-name", "Newsletter");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("link", { name: "Newsletter" })).toBeVisible();

  await page.getByRole("link", { name: "Newsletter" }).click();
  await page.waitForURL(/\/app\/contacts\/cb_/);
  await expect(page.getByText("No contacts yet")).toBeVisible();

  await page.fill("#c-email", "hopper@example.com");
  await page.fill("#c-first", "Grace");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "hopper@example.com" }),
  ).toBeVisible();

  // Search narrows; a search with no matches is its own state, not "empty book".
  await page.fill("#contact-q", "nobody");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("No matches")).toBeVisible();
  await page.fill("#contact-q", "hopper");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(
    page.getByRole("cell", { name: "hopper@example.com" }),
  ).toBeVisible();
  await page.fill("#contact-q", "");
  await page.getByRole("button", { name: "Search" }).click();

  // Leaving is one click. Coming back is confirmed, and the dialog names the
  // reason on the row and when they left.
  await page.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(page.getByText("manual", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Resubscribe" }).click();
  const speedBump = page.getByRole("dialog");
  await expect(speedBump).toBeVisible();
  // The two facts the operator needs to decide: who, and what the record says
  // about why they left. Asserted on the dialog rather than on a `prompt`
  // message, because the wording is the whole feature.
  await expect(speedBump).toContainText("hopper@example.com");
  await expect(speedBump).toContainText(
    "Only do this if they asked to come back",
  );
  await speedBump.getByRole("button", { name: "Cancel" }).click();
  // Cancelled: the speed bump has to actually stop the change.
  await expect(page.getByText("manual", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Resubscribe" }).click();
  await acceptConfirm(page, "Resubscribe");
  await expect(page.getByText("subscribed", { exact: true })).toBeVisible();

  // The import reports what it did, per row.
  await page.setInputFiles('input[type="file"]', {
    name: "contacts.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(CSV, "utf8"),
  });
  await expect(
    page.getByText(
      "2 added, 0 updated, 0 skipped, 0 duplicate rows collapsed.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "ada@example.com" }),
  ).toBeVisible();

  // The assertion this whole spec exists for: a name a spreadsheet would
  // execute comes back as text, quoted and prefixed with an apostrophe.
  const download = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Export CSV" }).click(),
  ]).then(([d]) => d);
  expect(download.suggestedFilename()).toBe("newsletter-contacts.csv");
  const csv = await readFile(await download.path(), "utf8");
  expect(csv).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
  expect(csv).not.toContain(',=HYPERLINK("http://evil.test")');
  // The whole book, with the properties column the import created.
  expect(csv.split("\n")[0]).toBe(
    "email,first_name,last_name,subscribed,unsubscribe_reason,created_at,plan",
  );
  for (const email of [
    "ada@example.com",
    "grace@example.com",
    "hopper@example.com",
  ])
    expect(csv).toContain(email);

  // Deleting the book is the one action here that needs settings.manage; this
  // owner has it.
  await page.goto("/app/contacts");
  await page.getByRole("button", { name: "Delete" }).click();
  // Gated on typing the book name: its contacts go with it and there is no
  // history to restore them from.
  await acceptTypedConfirm(page, "Delete book", "Newsletter");
  await expect(page.getByText("No contact books")).toBeVisible();
});
