import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { completeTeamSetup } from "./team-setup";
import { PgBoss } from "pg-boss";
import { Q } from "../../src/jobs/queues";

/**
 * One campaign, all the way through the real server: a book of three with one
 * suppressed and one unsubscribed, a body built block by block, the audience
 * card's arithmetic, the typed confirmation, the fan-out, and the two
 * unsubscribe URLs the mail carries.
 *
 * Runs after setup.spec.ts (project `app`), so the instance is set up and AWS
 * is "connected" to the fake. This spec needs the worker (the campaign sweeps
 * and `email.send` both run in-process, WORKER_MODE=inline) and a verified
 * domain of its own — setup.spec.ts and send.spec.ts each delete theirs, and
 * a campaign cannot be authored without one.
 *
 * ## The assertion this file exists for
 *
 * Step 8: **a GET on either unsubscribe URL must change nothing.** Corporate
 * mail security products — Defender, Proofpoint, Mimecast — fetch every link
 * in an incoming message before a human sees it. A GET that mutated would
 * silently unsubscribe recipients who never touched the mail, and the first
 * symptom would be a customer asking why their list is evaporating.
 *
 * `tests/integration/unsubscribe.test.ts` asserts that property against the
 * service. Only this spec asserts it against the **real route through the real
 * server**, which is where a stray `redirect()`, a prefetch, or a Server
 * Function invoked during render would actually show up — none of which a test
 * that calls the service can see. So the GET is made twice: once as a scanner
 * (a bare request with no session and no JavaScript) and once as a browser
 * that runs the page's client code and whatever it prefetches. Consent is
 * re-read from the dashboard, not from the unsubscribe page, so the check does
 * not depend on the surface under test to report on itself.
 *
 * The two URLs are deliberately different and both are asserted:
 * `/unsubscribe/:token` in the body (a page — safe to fetch) and
 * `/api/unsubscribe/:token` in `List-Unsubscribe` (the RFC 8058 POST). A page
 * segment cannot export `POST`, which is why they differ; they must still
 * carry the same token, or the header's one-click button unsubscribes somebody
 * else — or nobody.
 */

/* ------------------------------------------------------------------ *
 * Driving the sweeps
 * ------------------------------------------------------------------ */

/**
 * A campaign is moved along by three crons at `* * * * *`, so a spec that
 * waited for them would spend two minutes of wall clock doing nothing and
 * would still be asserting on a delay rather than on a fact.
 * `tests/integration/campaign-loop.test.ts` has the same problem and solves it
 * the same way: **send the tick explicitly and wait for that job to finish**.
 *
 * Sending the job rather than calling the handler is the point — it goes
 * through the queue the running server registered its handler on, so a sweep
 * that was never attached fails here rather than passing silently. The
 * difference from the integration test is only which process runs it: there
 * the worker is in-process, here it is the server under test, reached through
 * the queue table both share.
 *
 * The crons are **not** unscheduled, unlike the integration file. That test
 * asserts what happens in the gap between two ticks, so a free tick would
 * ruin it; every assertion here is about where the campaign converges, and a
 * cron tick that gets there first only makes the explicit tick a no-op.
 */
let boss: PgBoss | undefined;

/**
 * `DATABASE_URL` as the server under test sees it.
 *
 * CI puts it in the job environment, so it is already here. Locally it lives
 * in `apps/web/.env.local`, which Next loads for the server it starts and
 * which this process — Playwright's, not Next's — never reads. With
 * `E2E_BASE_URL` set the server is somebody else's (a container, say) and this
 * may not reach the same database; that mode is not what this spec is for.
 */
function databaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const path = fileURLToPath(new URL("../../.env.local", import.meta.url));
  let file: string;
  try {
    file = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `DATABASE_URL is not set and ${path} could not be read. The sweeps are driven by sending pg-boss jobs to the server's own database; this spec needs to reach it.`,
    );
  }
  const url = /^DATABASE_URL=(.+)$/m.exec(file)?.[1]?.trim();
  if (!url) throw new Error(`No DATABASE_URL in ${path}.`);
  return url;
}

/** Send-only pg-boss client: it neither supervises nor schedules anything. */
async function ticker(): Promise<PgBoss> {
  if (boss) return boss;
  const b = new PgBoss({
    connectionString: databaseUrl(),
    schema: "pgboss",
    // The server owns this schema and installed it at boot; this client only
    // puts jobs on queues that already exist.
    supervise: false,
    schedule: false,
    migrate: false,
  });
  // Without a listener an `error` event from the pool would take the runner
  // down; a connection blip here is not worth failing a run over.
  b.on("error", (e) => console.error("[e2e pg-boss]", e));
  await b.start();
  boss = b;
  return b;
}

/**
 * One sweep tick, run by the server's worker and awaited to completion.
 *
 * 60 s rather than 30: `tests/integration/domain-loop.test.ts` records a
 * shared CI runner reaching its first step at 32.8 s — a flake that failed a
 * tag build and passed on re-run. This waits on the same real worker polling
 * the same real queues from another process again, so it gets the same room.
 */
async function tick(queue: string): Promise<void> {
  const b = await ticker();
  const id = await b.send(queue, {});
  if (!id) throw new Error(`${queue}: send returned no job id`);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const job = await b.getJobById<object>(queue, id);
    // Archived out from under us counts as finished; what follows asserts on
    // the campaign, not on the job row.
    if (!job || job.state === "completed") return;
    if (job.state === "failed")
      throw new Error(`${queue} tick failed: ${JSON.stringify(job.output)}`);
    if (Date.now() > deadline)
      throw new Error(
        `${queue} tick did not finish in 60s (state ${job.state}) — is the server's worker running?`,
      );
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.afterAll(async () => {
  await boss?.stop({ graceful: false }).catch(() => undefined);
  boss = undefined;
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Reload until `locator` is visible: some pages refresh only every 15 s. */
async function reloadUntilVisible(page: Page, locator: Locator, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await locator.isVisible()) return;
    if (Date.now() > deadline) break;
    await page.waitForTimeout(1_000);
    await page.reload();
  }
  await expect(locator).toBeVisible();
}

/** The row of a table that mentions `text`, whichever table it is in. */
const rowFor = (page: Page, text: string) =>
  page.locator("tr").filter({ hasText: text });

/** One block card in the editor, addressed the way the editor numbers them. */
const blockCard = (page: Page, position: number, kind: string) =>
  page.locator("li").filter({ hasText: `${position}. ${kind}` });

/** The token out of either unsubscribe URL. They must be the same one. */
function tokenOf(url: string): string {
  const token = /\/unsubscribe\/([A-Za-z0-9_-]+)/.exec(url)?.[1];
  if (!token) throw new Error(`No unsubscribe token in ${url}`);
  return token;
}

test("a campaign reaches one eligible contact, and unsubscribing needs a POST", async ({
  page,
  request,
}) => {
  // Signup, a domain and the send itself; the sweeps are ticked explicitly,
  // so the budget is dominated by the domain rather than by any wait.
  test.setTimeout(240_000);
  // Unique per run: the dev database persists between runs.
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const domain = `mail.e2e-cmp-${suffix}.com`;
  const eligible = `stays-${suffix}@example.com`;
  const suppressed = `bounced-${suffix}@example.com`;
  const departed = `left-${suffix}@example.com`;
  const campaignName = `August notes ${suffix}`;
  const subject = `E2E campaign ${suffix}`;
  const blogUrl = `https://example.com/blog-${suffix}`;
  const buttonUrl = `https://example.com/notes-${suffix}`;
  const imageUrl = `https://cdn.example.com/banner-${suffix}.png`;
  const imageAlt = "The August banner";

  /* ---- a fresh owner, so the counts on the audience card are this spec's ---- */

  await page.goto("/signup");
  await page.fill("#name", "Campaigns");
  await page.fill("#email", `campaigns-${suffix}@example.com`);
  await page.fill("#password", "correct-horse-battery");
  await page.click("button[type=submit]");
  const createTeam = page.getByRole("button", { name: "Create team" });
  const checklist = page.getByText("Setup checklist");
  await expect(createTeam.or(checklist)).toBeVisible();
  if (await createTeam.isVisible()) {
    await page.fill("#name", `Campaigns ${suffix}`);
    await createTeam.click();
    // Team creation is a server action; the new team then lands on /setup
    // (unconnected) or /app. Either way, wait for it to leave /teams/new.
    await page.waitForURL(/\/(setup|app)/);
  }
  // Setup is per team now: a freshly created team is held on /setup until it
  // connects its own AWS account.
  await completeTeamSetup(page);

  /* ---- a verified domain: a campaign cannot be authored without one ---- */

  await page.goto("/app/domains/new");
  await page.fill("#name", domain);
  await page.getByRole("button", { name: "Add domain" }).click();
  await expect(page).toHaveURL(/\/app\/domains\/dom_/);
  // Provisioning is a job on the inline worker; the fake SES issues the DKIM
  // tokens, and with AWS_E2E_VERIFY=1 one Re-verify click flips it.
  await reloadUntilVisible(
    page,
    page.getByText(`e1._domainkey.${domain}`),
    30_000,
  );
  await page.getByRole("button", { name: "Re-verify" }).click();
  await reloadUntilVisible(
    page,
    page.getByText("verified", { exact: true }),
    30_000,
  );

  /* ---- 1. a book of three: one suppressed, one unsubscribed ---- */

  await page.goto("/app/contacts");
  await page.fill("#book-name", "Newsletter");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("link", { name: "Newsletter" }).click();
  await page.waitForURL(/\/app\/contacts\/cb_/);
  const bookUrl = page.url();

  for (const email of [eligible, suppressed, departed]) {
    await page.fill("#c-email", email);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("cell", { name: email })).toBeVisible();
  }

  // Consent off for one of them, through the button a support agent would use.
  await rowFor(page, departed)
    .getByRole("button", { name: "Unsubscribe" })
    .click();
  await expect(
    rowFor(page, departed).getByText("manual", { exact: true }),
  ).toBeVisible();

  // Deliverability off for another, through the suppressions surface. The two
  // are different facts about different people, which is what makes the
  // audience card's breakdown worth asserting.
  await page.goto("/app/suppressions");
  await page.fill("#sup-email", suppressed);
  await page.fill("#sup-note", `e2e ${suffix}`);
  await page.getByRole("button", { name: "Suppress" }).click();
  await expect(page.getByRole("cell", { name: suppressed })).toBeVisible();

  /* ---- 2. the campaign body, block by block ---- */

  await page.goto("/app/campaigns");
  await page.getByRole("link", { name: "New campaign" }).first().click();
  await page.waitForURL("**/app/campaigns/new");
  await page.fill("#cmp-name", campaignName);
  await page.fill("#cmp-subject", subject);
  // The book and the domain are each the team's only one, so the form already
  // names them; asserting that is cheaper than re-selecting them.
  await expect(page.locator("#cmp-book")).toHaveValue(/^cb_/);
  await expect(page.locator("#cmp-from")).toHaveValue(`hello@${domain}`);

  // The starter body is a heading and a text block; the other two are added.
  await blockCard(page, 1, "Heading")
    .getByLabel("Text", { exact: true })
    .fill("What we shipped in August");

  const body = page.getByLabel("Campaign text block");
  const bold = page.getByRole("button", { name: "Bold", exact: true });
  await body.click();
  await expect(body).toBeFocused();

  // The toolbar must leave the caret in the document *before its click
  // handler returns*, and that is asserted here rather than by typing,
  // because no Playwright assertion can see it. Tiptap's `focus()` command
  // defers `view.focus()` into a `requestAnimationFrame`, so the gap is one
  // frame wide: by the time a retrying `toBeFocused()` looks, or a
  // `keyboard.type` has crossed the wire, the frame has run and the bug has
  // healed itself — while a person typing at speed loses the character. The
  // only way to catch it is to dispatch the click and read
  // `document.activeElement` in the same task, inside the page.
  //
  // `click()` on a focused button is also the keyboard path exactly: Enter or
  // Space on a toolbar button fires `click` with no `mousedown` to prevent,
  // which is the half that `preventDefault` cannot cover. Bold is toggled on
  // and straight back off, so the body is left as it was found.
  const caretStayedInTheDocument = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Bold",
    );
    const editor = document.querySelector('[aria-label="Campaign text block"]');
    if (!button || !editor) return "the toolbar or the editor is not there";
    const press = () => {
      button.focus();
      button.click();
      return document.activeElement === editor;
    };
    const on = press();
    const off = press();
    return on && off
      ? true
      : `focus was still on the button after ${on ? "the second" : "the first"} click`;
  });
  expect(caretStayedInTheDocument).toBe(true);

  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Read the ");
  // Click, then type — with nothing awaited in between, which is the point.
  // The toolbar button never takes focus off the contenteditable, so the very
  // next keystroke lands in the document. A spec that waited here for focus to
  // come back would be asserting on its own patience: the first character
  // would go missing for every real author typing at speed, and this would
  // still pass. The marks are checked after the text, never before it.
  await bold.click();
  await page.keyboard.type("August notes");
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await bold.click();
  await page.keyboard.type(", or visit the blog");
  await expect(bold).toHaveAttribute("aria-pressed", "false");
  // Select "the blog" and link it. The editor asks for the URL with a
  // `window.prompt`, so the URL arrives the way a person would give it.
  for (let i = 0; i < "the blog".length; i++)
    await page.keyboard.press("Shift+ArrowLeft");
  page.once("dialog", (d) => void d.accept(blogUrl));
  await page.getByRole("button", { name: "Link", exact: true }).click();

  await page.getByRole("button", { name: "+ Button" }).click();
  const buttonBlock = blockCard(page, 3, "Button");
  await buttonBlock.getByLabel("Label").fill("Read the notes");
  await buttonBlock.getByLabel("Links to", { exact: true }).fill(buttonUrl);

  await page.getByRole("button", { name: "+ Image" }).click();
  const imageBlock = blockCard(page, 4, "Image");
  await imageBlock.getByLabel("Image URL").fill(imageUrl);
  await imageBlock.getByLabel("Alt text").fill(imageAlt);

  /* ---- 3. the preview is the rendered HTML, not a second renderer ---- */

  const preview = page.frameLocator('iframe[title="Campaign preview"]');
  await expect(
    preview.getByRole("heading", { name: "What we shipped in August" }),
  ).toBeVisible();
  await expect(preview.locator("strong")).toHaveText("August notes");
  await expect(preview.getByRole("link", { name: "the blog" })).toHaveAttribute(
    "href",
    blogUrl,
  );
  await expect(
    preview.getByRole("link", { name: "Read the notes" }),
  ).toHaveAttribute("href", buttonUrl);
  await expect(preview.getByRole("img", { name: imageAlt })).toHaveAttribute(
    "src",
    imageUrl,
  );
  // The footer the fan-out fills in per recipient, standing in for the link.
  await expect(
    preview.getByText("Unsubscribe (a link unique to each recipient)"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/\/app\/campaigns\/cmp_/);
  const campaignUrl = page.url();
  const campaignId = /cmp_[A-Za-z0-9_-]+/.exec(campaignUrl)![0];

  /* ---- 4. the audience: three contacts, one of them reachable ---- */

  // Four views of one population, read off the card's own definition list.
  const stat = (label: string) =>
    page.locator("dl > div").filter({ hasText: label });
  await expect(stat("Contacts")).toContainText("3");
  await expect(stat("Subscribed")).toContainText("2");
  await expect(stat("Suppressed")).toContainText("1");
  await expect(stat("Eligible")).toContainText("1");
  // The sentence above them — one element, so the count and the words that
  // give it meaning reach a screen reader together rather than as a fragment
  // beginning "person receives…". Its verb agrees with the number too.
  await expect(
    page.getByText("1 person receives this campaign, of 3 in Newsletter."),
  ).toBeVisible();
  // Both exclusions are named, and both are somebody different: the
  // suppressed contact still consents, the unsubscribed one is deliverable.
  await expect(
    page.getByText("2 people in this book will not receive it:"),
  ).toBeVisible();
  await expect(page.getByText("1 unsubscribed.")).toBeVisible();
  await expect(page.getByText("1 suppressed.")).toBeVisible();
  // …and nobody is both, so the card does not claim an overlap it does not
  // have. That line only renders when the two reasons double-count somebody.
  await expect(
    page.getByText("are both unsubscribed and suppressed"),
  ).toHaveCount(0);

  /* ---- 5. send it, typing the name to confirm ---- */

  await page.getByRole("button", { name: "Send to 1 person…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", {
    name: "Send to 1 person",
    exact: true,
  });
  // The friction is the feature: until the name is typed exactly, the button
  // that mails everybody does nothing.
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("textbox").fill(campaignName);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("Armed. The send starts on its own at the time below"),
  ).toBeVisible();

  // Armed means "due on the next tick", so here are the ticks: one to start
  // the campaign (renders the body once, stamps `started_at`, mails nobody),
  // one to materialise the chunk, one to find nothing left and finish it.
  await tick(Q.campaignStartSweep);
  await tick(Q.campaignFanoutSweep);
  await tick(Q.campaignFanoutSweep);

  await page.goto(campaignUrl);
  await reloadUntilVisible(
    page,
    page.getByText("sent", { exact: true }),
    60_000,
  );
  // Anchored: three other stat tiles explain themselves with the word
  // "recipients" and would match a bare substring.
  await expect(page.getByRole("link", { name: /^Recipients/ })).toContainText(
    "1",
  );

  /* ---- 6. exactly one mail-log row, addressed to the one eligible contact ---- */

  await page.getByRole("link", { name: "Mail log" }).click();
  await page.waitForURL(new RegExp(`campaignId=${campaignId}`));
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("cell", { name: eligible })).toBeVisible();
  for (const missed of [suppressed, departed])
    await expect(page.getByText(missed)).toHaveCount(0);

  /* ---- 7. the body carries the page link; the row carries the header ---- */

  await page.getByRole("link", { name: subject }).click();
  await page.waitForURL(/\/app\/emails\/em_/);
  const sent = page.frameLocator('iframe[title="Email preview"]');
  const footer = sent.getByRole("link", { name: "Unsubscribe" });
  await expect(footer).toBeVisible();
  const pageUrl = (await footer.getAttribute("href")) ?? "";
  expect(pageUrl).toContain("/unsubscribe/");
  // The body's link is the *page*, never the API route: a link scanner has to
  // be able to fetch it.
  expect(pageUrl).not.toContain("/api/unsubscribe/");

  await page.getByRole("button", { name: "Headers" }).click();
  const headerValue =
    (await page.locator('td:text-is("List-Unsubscribe") + td').textContent()) ??
    "";
  // RFC 8058: the header names a URI that accepts a POST — which an App Router
  // segment holding a `page.tsx` cannot export, so it is the API route.
  expect(headerValue).toContain("/api/unsubscribe/");
  await expect(
    page.locator('td:text-is("List-Unsubscribe-Post") + td'),
  ).toHaveText("List-Unsubscribe=One-Click");
  const apiUrl = headerValue.replace(/^</, "").replace(/>$/, "");

  // Two routes, one token. A mismatch would unsubscribe somebody else — or,
  // more likely, nobody, and silently.
  const token = tokenOf(pageUrl);
  expect(tokenOf(apiUrl)).toBe(token);

  /* ---- 8. a GET changes nothing; a POST does ---- */

  /** Consent as the dashboard reports it — not as the unsubscribe page does. */
  const consentSays = async (state: string) => {
    await page.goto(bookUrl);
    await expect(
      rowFor(page, eligible).getByText(state, { exact: true }),
    ).toBeVisible();
  };

  // A scanner: no session, no JavaScript, both URLs, exactly what Defender,
  // Proofpoint and Mimecast do to every link in an incoming message. The API
  // route answers a 302 to the page, which must also only render.
  for (const url of [pageUrl, apiUrl]) {
    const scan = await request.get(url);
    expect(scan.status(), `GET ${url}`).toBe(200);
    expect(await scan.text()).toContain("Nothing has changed yet.");
  }

  // And a real browser, which runs the page's client code and any prefetch it
  // starts — the way a Server Function invoked during render, or a `redirect`
  // into one, would actually show up.
  await page.goto(pageUrl);
  await expect(
    page.getByRole("heading", { name: `Unsubscribe ${eligible}?` }),
  ).toBeVisible();
  await expect(page.getByText("Nothing has changed yet.")).toBeVisible();

  // Four GETs later, they are still subscribed. This is the assertion the
  // whole spec is built around.
  await consentSays("subscribed");

  // The POST is the only thing that removes consent.
  const post = await request.post(apiUrl);
  const answer = await post.text();
  expect(post.status(), answer).toBe(200);
  expect(answer).toContain("You have been unsubscribed.");

  // The reason names the campaign that prompted it, so a support agent can
  // see which mail somebody left over.
  await consentSays(`campaign:${campaignId}`);
  await page.goto(pageUrl);
  await expect(
    page.getByRole("heading", { name: "You're unsubscribed." }),
  ).toBeVisible();
});
