import { expect, type Page } from "@playwright/test";

/**
 * Driving the dashboard's own controls, now that none of them are native.
 *
 * `page.selectOption` and `page.once("dialog", …)` both address browser
 * chrome, and the dashboard no longer uses any: a `<select>` became an ARIA
 * listbox and `window.confirm` became a modal, because on a dark surface the
 * native versions are drawn by the OS and cannot be styled, cannot show a
 * count or a warning, and — in the case of `confirm` — block the main thread
 * over a spinner that has just started.
 *
 * The helpers below are the replacements. Keeping them in one file means the
 * next change to either component is one edit rather than fifteen.
 */

/**
 * Picks an option from a {@link Select} by its visible label.
 *
 * `id` is the id passed to the component, which is the id of the trigger
 * button — the same string the old `page.selectOption("#region", …)` used, so
 * a call site is a one-word change.
 */
export async function chooseOption(page: Page, id: string, label: string) {
  const trigger = page.locator(`#${id}`);
  await expect(trigger).toBeVisible();
  await trigger.click();
  // By `data-label`, not by accessible name: an option that carries a hint
  // ("Full — every endpoint this team can reach") has both strings in its
  // name, and a test that wants the label should not have to know the hint.
  await page.locator(`#${id}-listbox [data-label="${label}"]`).click();
  await expect(trigger).toContainText(label);
}

/** The confirm modal's own text, so a mis-click on the wrong dialog is loud. */
export async function acceptConfirm(page: Page, confirmLabel: string) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: confirmLabel, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * The confirm modal, when it is gated on typing something exact.
 *
 * The gate is deliberate on the handful of actions that destroy something
 * unrecoverable, so a test that skips it is testing a different button.
 */
export async function acceptTypedConfirm(
  page: Page,
  confirmLabel: string,
  typed: string,
) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("#confirm-gate").fill(typed);
  await dialog.getByRole("button", { name: confirmLabel, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Opens the visual editor's preview and returns the frame.
 *
 * The designer has one preview, reached by the Edit/Preview switch — it used
 * to also have a permanent panel, which meant two previews of the same body on
 * one screen and a "desktop" one narrower than the phone. Tests that read the
 * rendered document have to ask for it.
 */
export async function openPreview(page: Page, title: string) {
  await page.getByRole("radio", { name: "Preview" }).click();
  return page.frameLocator(`iframe[title="${title}"]`);
}

/** Back to the canvas, for a test that keeps editing afterwards. */
export async function closePreview(page: Page) {
  await page.getByRole("radio", { name: "Edit" }).click();
}
