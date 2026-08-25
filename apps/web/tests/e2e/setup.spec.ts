import { expect, test, type Page } from "@playwright/test";
import { saveApiKey } from "./credentials";

// The server runs with AWS_E2E_MOCK=1: SES/SNS/STS answer from
// src/lib/aws/fake-client.ts (account 111111111111, DKIM tokens e1..e3,
// identity stays PENDING). DNS checks hit real resolvers and find nothing,
// so the domain stays pending with its records listed — the state under test.

/** Reload until `locator` is visible: pending pages self-refresh only every 15 s. */
async function reloadUntilVisible(
  page: Page,
  locator: ReturnType<Page["getByText"]>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await locator.isVisible()) return;
    if (Date.now() > deadline) break;
    await page.waitForTimeout(1_000);
    await page.reload();
  }
  await expect(locator).toBeVisible();
}

/** Manual-keys path of the AWS step; same ids on /setup and Settings → Instance. */
async function connectAwsWithKeys(page: Page) {
  await page.getByRole("button", { name: "Paste keys manually" }).click();
  await page.selectOption("#region", "us-east-1");
  await page.fill("#accessKeyId", "AKIAE2EEXAMPLE0001");
  await page.fill("#secretAccessKey", "e2e-secret-e2e-secret");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
}

test("owner completes setup via manual keys, adds a domain, sees records", async ({
  page,
}) => {
  // Unique per run: the dev database persists between runs.
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const domain = `mail.e2e-${suffix}.com`;

  await page.goto("/signup");
  await page.fill("#name", "Owner");
  await page.fill("#email", `owner-${suffix}@example.com`);
  await page.fill("#password", "correct-horse-battery");
  await page.click("button[type=submit]");

  // Signup lands on /teams/new (no team yet) or, on a used database with a
  // team already attached, straight in the app. See smoke.spec.ts.
  const createTeam = page.getByRole("button", { name: "Create team" });
  const checklist = page.getByText("Setup checklist");
  const wizard = page.getByRole("navigation", { name: "Setup steps" });
  await expect(createTeam.or(checklist).or(wizard)).toBeVisible({
    timeout: 30_000,
  });
  if (await createTeam.isVisible()) {
    await page.fill("#name", `Acme ${suffix}`);
    await createTeam.click();
    // The team creator is an owner: a fresh instance sends them to the
    // wizard, an instance that already finished setup to the dashboard.
    await expect(wizard.or(checklist)).toBeVisible({ timeout: 30_000 });
  }

  if (await wizard.isVisible()) {
    // Fresh instance (CI): the whole wizard, manual keys.
    await expect(page).toHaveURL(/\/setup/);
    await connectAwsWithKeys(page);
    // A successful connect refreshes /setup (no `step`), and the server then
    // picks the first unfinished step: production access, in the sandbox.
    await expect(
      page.getByRole("heading", { name: "SES production access" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("sandbox", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page).toHaveURL(/step=cloudflare/);
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await expect(page).toHaveURL(/step=done/);
    await expect(
      page.getByText("AWS connected · 111111111111 · us-east-1"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Go to dashboard" }).click();
    await expect(page).toHaveURL(/\/app$/);
  } else {
    // Setup already completed (local dev database): the same AWS step lives
    // on the Instance tab, without the wizard's Continue/Skip. If a previous
    // run (or the developer) already connected AWS, keep that connection —
    // the fake answers regardless of the stored keys.
    await page.goto("/app/settings/instance");
    const manual = page.getByRole("button", { name: "Paste keys manually" });
    const connected = page.getByText("AWS is connected");
    await expect(manual.or(connected)).toBeVisible();
    if (await manual.isVisible()) {
      await connectAwsWithKeys(page);
      await expect(connected).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("111111111111")).toBeVisible();
    }
  }

  await page.goto("/app/domains/new");
  await page.fill("#name", domain);
  await page.getByRole("button", { name: "Add domain" }).click();
  await expect(page).toHaveURL(/\/app\/domains\/dom_/);

  // Provisioning is a job on the inline worker; the fake SES issues the DKIM
  // tokens and the records table replaces the "Records appear once…" note.
  await reloadUntilVisible(
    page,
    page.getByText(`e1._domainkey.${domain}`),
    30_000,
  );
  await expect(page.getByText(`_dmarc.${domain}`)).toBeVisible();
  await expect(page.getByText(`e3._domainkey.${domain}`)).toBeVisible();
  // Re-verify is gated on the stored tokens, so it is enabled now.
  await expect(page.getByRole("button", { name: "Re-verify" })).toBeEnabled();
  await expect(page.getByText("pending", { exact: true })).toBeVisible();

  // Clean up through the UI (fake DeleteEmailIdentity); the name is unique
  // instance-wide, so leaving it would only clutter the dev database.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/app\/domains$/);
  await expect(page.getByText(domain)).toHaveCount(0);

  // A full-permission key on this team, for sdk.spec.ts. Created through the
  // UI because that is the only place the secret is ever shown, and handed
  // over in a file (see ./credentials) — env vars do not cross workers.
  await page.goto("/app/api-keys");
  await page.fill("#key-name", `e2e-sdk-${suffix}`);
  await page.selectOption("#key-permission", "full");
  await page.getByRole("button", { name: "Create key" }).click();
  // The keys table also shows the prefix in a <code>; the CopyField's is the
  // `select-all` one (same locator as send.spec.ts).
  const secret = (
    await page
      .locator("code.select-all", { hasText: /^ss_live_/ })
      .textContent()
  )?.trim();
  expect(secret).toMatch(/^ss_live_/);
  saveApiKey(test.info(), secret!);
});
