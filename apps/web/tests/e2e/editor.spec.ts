import { expect, test, type Page } from "@playwright/test";
import { completeTeamSetup } from "./team-setup";
import { chooseOption, openPreview } from "./_ui";

/**
 * Three of the four things the editor gained after the first UI pass:
 * uploading an image, reusable layouts, and a body theme. The date-time picker
 * is covered in `campaigns.spec.ts`, which is the only page it appears on and
 * already has the verified domain that page needs.
 *
 * Runs on its own team so the image library and the layout list both start
 * empty — both are per team, and an assertion on "the first tile" is only
 * meaningful when there is nothing else in the grid.
 */

/** A one-pixel PNG. The upload path sniffs the header, so it has to be real. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c630001000005000" +
    "10d0a2db40000000049454e44ae426082",
  "hex",
);

async function signUpOwner(page: Page, label: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto("/signup");
  await page.fill("#name", "Editor");
  await page.fill("#email", `${label}-${suffix}@example.com`);
  await page.fill("#password", "correct-horse-battery");
  await page.click("button[type=submit]");
  const createTeam = page.getByRole("button", { name: "Create team" });
  await expect(createTeam.or(page.getByText("Setup checklist"))).toBeVisible();
  if (await createTeam.isVisible()) {
    await page.fill("#name", `Editor ${suffix}`);
    await createTeam.click();
    await page.waitForURL(/\/(setup|app)/);
  }
  await completeTeamSetup(page);
  return suffix;
}

test("an uploaded image is served publicly and lands in the block", async ({
  page,
  request,
}) => {
  await signUpOwner(page, "assets");
  await page.goto("/app/templates/new");

  // The image block starts on a URL nobody owns; the library is the point.
  await page.getByRole("button", { name: "Add Image", exact: true }).click();
  await page.getByRole("button", { name: "Library" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog
    .locator('input[type="file"]')
    .setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });

  // Picking closes the dialog and writes the URL into the block.
  await expect(dialog).toHaveCount(0);
  const url = await page.getByLabel("Image URL").inputValue();
  expect(url).toMatch(/\/a\/[A-Za-z0-9_-]{32}$/);

  /* ---- the URL is what a mail client will fetch, so fetch it that way ---- */

  // A bare request: no cookie, no session. If this needed one, every image in
  // every campaign would be a broken image in every inbox.
  const res = await request.get(url, { headers: {} });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/png");
  // The headers that stop a crafted upload being treated as active content
  // from this origin.
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["content-security-policy"]).toContain("sandbox");
  expect(Buffer.from(await res.body()).equals(PNG)).toBe(true);

  // And it reaches the rendered body.
  await page.getByLabel("Alt text").fill("The logo");
  const preview = await openPreview(page, "Template preview");
  await expect(preview.getByRole("img", { name: "The logo" })).toHaveAttribute(
    "src",
    url,
  );
});

test("the image library refuses an SVG", async ({ page }) => {
  await signUpOwner(page, "svg");
  await page.goto("/app/templates/new");
  await page.getByRole("button", { name: "Add Image", exact: true }).click();
  await page.getByRole("button", { name: "Library" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "x.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  });
  // Refused on the bytes, and said in words rather than as a status code.
  await expect(dialog.getByRole("alert")).toContainText("SVG");
  await expect(dialog).toBeVisible();
});

test("a layout inserts its blocks, and a saved one comes back", async ({
  page,
}) => {
  await signUpOwner(page, "layouts");
  await page.goto("/app/templates/new");

  // A preset is blocks, not a template: inserting one appends cards the author
  // can edit like any others.
  await page
    .getByRole("button", { name: "Insert the Footer layout", exact: true })
    .click();
  const preview = await openPreview(page, "Template preview");
  await expect(preview.getByText("1 Example Street")).toBeVisible();
  await page.getByRole("radio", { name: "Edit" }).click();

  // Save the whole body as the team's own layout.
  await page.getByRole("button", { name: "Save this as a layout" }).click();
  const save = page.getByRole("dialog");
  await save.locator("#layout-name").fill("Our footer");
  await save.getByRole("button", { name: "Save layout" }).click();
  await expect(save).toHaveCount(0);
  await expect(page.getByText('Saved "Our footer"')).toBeVisible();

  // It is per team and persisted, so it is there on the next body too.
  await page.goto("/app/templates/new");
  await expect(
    page.getByRole("button", { name: "Insert the Our footer layout" }),
  ).toBeVisible();
});

test("the body theme reaches the rendered document", async ({ page }) => {
  await signUpOwner(page, "theme");
  await page.goto("/app/templates/new");

  // Nothing selected means the style panel is the body's, which is where a
  // theme is set. The selection breadcrumb's first step goes there from
  // anywhere, which is the point of it.
  await page
    .getByRole("navigation", { name: "Selection" })
    .getByRole("button", { name: "Body" })
    .click();
  await page.getByRole("radio", { name: "480" }).click();
  await page.getByRole("radio", { name: "Serif" }).click();

  const frame = await openPreview(page, "Template preview");
  // The card follows the theme, and so does the font — both inline, so both
  // are readable off the rendered document rather than off a stylesheet.
  await expect(frame.locator("table.ss-card")).toHaveAttribute("width", "480");
  await expect(frame.locator("h2").first()).toHaveCSS("font-family", /Georgia/);
});

test("the canvas draws the email, and preview mode drops the chrome", async ({
  page,
}) => {
  await signUpOwner(page, "canvas");
  await page.goto("/app/templates/new");

  // The canvas is the body rendered by the send's own code, not a stack of
  // labelled inputs: the starter heading is a real heading on it.
  const canvas = page.getByRole("list", { name: "Email body" });
  await expect(canvas.getByRole("heading").first()).toBeVisible();

  // Space is a block's own, and it reaches the document.
  await canvas.getByRole("listitem", { name: "Heading block" }).click();
  const inspector = page.getByRole("region", { name: "Block settings" });
  await chooseOption(page, "space-above", "48");

  /*
   * A div inside the column, not a table cell.
   *
   * Every block sits in a row of one column now, and a leaf's own space inside
   * a cell is a wrapping `div`: Outlook adds cell padding to the cell's width,
   * and the cell carries the column's width, so padding there would overflow
   * the row by exactly that much.
   *
   * Preview is also the only preview — there is no panel beside the canvas —
   * so opening it is what puts the frame on screen, and it takes the palette
   * and the inspector away while it is there.
   */
  const frame = await openPreview(page, "Template preview");
  await expect(frame.locator('div[style*="padding:48px"]')).toHaveCount(1);
  await expect(inspector).toBeHidden();
  await expect(canvas).toBeHidden();
  await expect(frame.locator("table.ss-card")).toBeVisible();

  await page.getByRole("radio", { name: "Edit" }).click();
  await expect(canvas).toBeVisible();
});

test("every block is a row, and the breadcrumb is how you reach it", async ({
  page,
}) => {
  await signUpOwner(page, "crumbs");
  await page.goto("/app/templates/new");

  const canvas = page.getByRole("list", { name: "Email body" });
  const crumbs = page.getByRole("navigation", { name: "Selection" });
  const inspector = page.getByRole("region", { name: "Block settings" });

  // Every block sits in a row of one, so an ordinary paragraph has the things
  // only a row used to have. A row is a container and cannot be clicked — the
  // breadcrumb is the way up to it.
  await canvas.getByRole("listitem", { name: "Heading block" }).click();
  await expect(crumbs).toContainText("Heading");
  await crumbs.getByRole("button", { name: "Row" }).click();
  await expect(inspector).toContainText("Vertical alignment");
  // Nothing sits beside it, so there is no gutter to set.
  await expect(page.locator("#column-gap")).toHaveCount(0);

  // A row with columns has one, and it reaches the rendered document.
  await page.getByRole("button", { name: "Add Two columns" }).click();
  await canvas.getByRole("listitem", { name: "Two columns row" }).click();
  await chooseOption(page, "column-gap", "48");

  const frame = await openPreview(page, "Template preview");
  await expect(frame.locator('td.ss-gutter[width="48"]')).toBeVisible();
});

test("a heading is typed where it sits, and stays a heading", async ({
  page,
}) => {
  await signUpOwner(page, "headings");
  await page.goto("/app/templates/new");

  // Not a textbox pretending to be a heading: it is the element the email
  // will carry, so the canvas has the same structure as the thing it previews.
  const canvas = page.getByRole("list", { name: "Email body" });
  const heading = canvas.getByRole("heading").first();
  await heading.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and again");

  const frame = await openPreview(page, "Template preview");
  await expect(frame.getByRole("heading")).toContainText("and again");
});
