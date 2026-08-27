import { expect, test, type Page } from "@playwright/test";
import { completeTeamSetup } from "./team-setup";
import nodemailer from "nodemailer";
import { acceptTypedConfirm } from "./_ui";

// Runs after setup.spec.ts (project `app`), so the instance is set up and
// AWS is "connected" to the fake. The server has AWS_E2E_VERIFY=1 (fake SES
// reports DKIM/MAIL FROM SUCCESS → Re-verify flips the domain to verified),
// WORKER_MODE=inline (email.send runs in-process; SendEmail answers
// `fake-<n>`) and the SMTP relay on 2587 with insecure AUTH allowed.

const SMTP_PORT = 2587;

/** Reload until `locator` is visible: some pages refresh only every 15 s. */
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

/** Open `/app/emails/<id>` and wait for both the queued and sent events. */
async function expectQueuedAndSent(page: Page, id: string) {
  await page.goto(`/app/emails/${id}`);
  await page.getByRole("button", { name: /Events/ }).click();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  const deadline = Date.now() + 30_000;
  const sent = page.getByText("Sent to SES", { exact: true });
  while (!(await sent.isVisible()) && Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    await page.reload();
    await page.getByRole("button", { name: /Events/ }).click();
  }
  await expect(sent).toBeVisible();
}

test("owner verifies a domain, sends via REST and SMTP, sees the log", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Unique per run: the dev database persists between runs.
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const domain = `mail.e2e-send-${suffix}.com`;

  await page.goto("/signup");
  await page.fill("#name", "Sender");
  await page.fill("#email", `sender-${suffix}@example.com`);
  await page.fill("#password", "correct-horse-battery");
  await page.click("button[type=submit]");
  const createTeam = page.getByRole("button", { name: "Create team" });
  const checklist = page.getByText("Setup checklist");
  await expect(createTeam.or(checklist)).toBeVisible();
  if (await createTeam.isVisible()) {
    await page.fill("#name", `Send ${suffix}`);
    await createTeam.click();
    // Team creation is a server action; the new team then lands on /setup
    // (unconnected) or /app. Either way, wait for it to leave /teams/new.
    await page.waitForURL(/\/(setup|app)/);
  }
  // Setup is per team now: a freshly created team is held on /setup until it
  // connects its own AWS account.
  await completeTeamSetup(page);

  // Domain: provisioning is an inline job; the records table appears once
  // the fake SES has issued the DKIM tokens. Re-verify runs verifyDomain
  // inline and, with the fake reporting SUCCESS, the domain is verified.
  await page.goto("/app/domains/new");
  await page.fill("#name", domain);
  await page.getByRole("button", { name: "Add domain" }).click();
  // Server action, then a client-side push; the config's global `expect`
  // timeout covers the wait.
  await expect(page).toHaveURL(/\/app\/domains\/dom_/);
  const domainUrl = page.url();
  await reloadUntilVisible(
    page,
    page.getByText(`e1._domainkey.${domain}`),
    30_000,
  );
  await expect(page.getByRole("button", { name: "Re-verify" })).toBeEnabled();
  await page.getByRole("button", { name: "Re-verify" }).click();
  await reloadUntilVisible(
    page,
    page.getByText("verified", { exact: true }),
    30_000,
  );

  // API key: the secret is shown once in a CopyField.
  await page.goto("/app/api-keys");
  await page.fill("#key-name", `e2e-${suffix}`);
  await page.getByRole("button", { name: "Create key" }).click();
  // The keys table also shows the prefix in a <code>; the CopyField's is
  // the `select-all` one.
  const secret = (
    await page
      .locator("code.select-all", { hasText: /^ss_live_/ })
      // The key is minted by a server action, and `textContent` is a locator
      // call, not an assertion — the global `expect` timeout does not reach
      // it, so the same allowance is spelled out here.
      .textContent({ timeout: 10_000 })
  )?.trim();
  expect(secret).toMatch(/^ss_live_/);
  const authorization = `Bearer ${secret}`;

  // REST send → 201 { id }; worker inline + fake SES → sent.
  const apiSubject = `E2E API ${suffix}`;
  const res = await page.request.post("/api/v1/emails", {
    headers: { authorization },
    data: {
      from: `hello@${domain}`,
      to: "r@example.com",
      subject: apiSubject,
      html: "<p>hi</p>",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  expect(id).toMatch(/^em_/);
  expect(res.headers()["x-ratelimit-limit"]).toBeTruthy();

  await page.goto("/app/emails");
  await expect(page.getByRole("link", { name: apiSubject })).toBeVisible();
  await expectQueuedAndSent(page, id);

  // Sending *with a template*, over the real API: the whole point is that the
  // subject and bodies stored on the row are the rendered ones, and that the
  // escaping is decided by the field rather than by the caller. Nothing else
  // in the suite drives that path end to end — the templates spec never sends,
  // and the integration tests call the service rather than the route.
  const slug = `welcome-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const tpl = await page.request.post("/api/v1/templates", {
    headers: { authorization },
    data: {
      slug,
      name: "Welcome",
      subject: `E2E {{ name }} ${suffix}`,
      bodyHtml: "<p>Hello {{ name }}, welcome.</p>",
      bodyText: "Hello {{ name }}, welcome.",
    },
  });
  expect(tpl.status(), await tpl.text()).toBe(201);

  const templated = await page.request.post("/api/v1/emails", {
    headers: { authorization },
    data: {
      from: `hello@${domain}`,
      to: "t@example.com",
      template: slug,
      variables: { name: "<Ada>" },
    },
  });
  expect(templated.status(), await templated.text()).toBe(201);
  const { id: templatedId } = (await templated.json()) as { id: string };

  // The mail log lists the *rendered* subject, not the template's source.
  const renderedSubject = `E2E <Ada> ${suffix}`;
  await page.goto("/app/emails");
  await expect(page.getByRole("link", { name: renderedSubject })).toBeVisible();

  // The stored bodies are the rendered ones, and the value is escaped in the
  // HTML body and raw in the text body.
  await page.goto(`/app/emails/${templatedId}`);
  await page.getByRole("button", { name: "Text" }).click();
  await expect(page.getByText("Hello <Ada>, welcome.")).toBeVisible();
  await page.getByRole("button", { name: "Preview" }).click();
  const sentPreview = page.frameLocator('iframe[title="Email preview"]');
  await expect(sentPreview.locator("p")).toContainText("Hello <Ada>, welcome.");
  await expectQueuedAndSent(page, templatedId);

  // SMTP relay: any username, API key as password, plain connection (the
  // server has SMTP_ALLOW_INSECURE_AUTH=true; the cert is self-signed).
  const smtpSubject = `E2E SMTP ${suffix}`;
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: SMTP_PORT,
    secure: false,
    ignoreTLS: true,
    auth: { user: "e2e", pass: secret! },
    tls: { rejectUnauthorized: false },
  });
  const info = await transport.sendMail({
    from: `hello@${domain}`,
    to: "s@example.com",
    subject: smtpSubject,
    html: "<p>via smtp</p>",
  });
  transport.close();
  expect(info.response).toMatch(/^250/);

  // The relay answers a plain 250, so the row is found by its subject.
  await page.goto("/app/emails");
  const smtpRow = page.getByRole("link", { name: smtpSubject });
  await expect(smtpRow).toBeVisible();
  await smtpRow.click();
  await expect(page).toHaveURL(/\/app\/emails\/em_/);
  const smtpId = /em_[A-Za-z0-9_-]+/.exec(page.url())![0];
  await expect(page.getByText("smtp", { exact: true })).toBeVisible();
  await expectQueuedAndSent(page, smtpId);

  // Overview tiles count both sends.
  await page.goto("/app");
  const tile = page.locator("p.num-stamp", { hasText: "Sent · 24 h" });
  const n = Number(
    (await tile.locator("xpath=following-sibling::p").textContent())?.replace(
      /,/g,
      "",
    ),
  );
  expect(n).toBeGreaterThanOrEqual(2);

  // Clean up the domain (fake DeleteEmailIdentity); the mail log keeps its
  // rows with domain_id = null.
  await page.goto(domainUrl);
  await page.getByRole("button", { name: "Delete" }).click();
  await acceptTypedConfirm(page, "Delete domain", domain);
  // deleteDomain (server action) then `router.push("/app/domains")`: the URL
  // only changes once the action has returned and the list has rendered.
  await expect(page).toHaveURL(/\/app\/domains$/);
});
