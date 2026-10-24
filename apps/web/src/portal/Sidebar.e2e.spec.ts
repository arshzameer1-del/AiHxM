import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../e2e-support/real-session";

/**
 * Side menu, as in the Claude app: always there on a computer, wide (icon and name) or collapsed to an icon strip with one button,
 * remembered between visits; on a phone a drawer that opens from the menu button.
 */
test.describe("Side menu", () => {
  test("is wide by default with one collapse button and no hamburger or pin in the corner", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    const menu = page.locator("#app-sidebar");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("link", { name: "Employees" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Pin menu open|Unpin menu|Open menu|Close menu/ })).toHaveCount(0);
    const box = await menu.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(200);
  });

  test("the button collapses it to icons, widens it again and remembers the choice", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    const menu = page.locator("#app-sidebar");
    await page.getByRole("button", { name: "Collapse menu" }).click();
    await expect.poll(async () => (await menu.boundingBox())?.width ?? 999).toBeLessThan(90);
    // Names are gone but every page is still a link with its name.
    await expect(menu.getByRole("link", { name: "Employees" }).first()).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: "Expand menu" })).toBeVisible();
    await page.getByRole("button", { name: "Expand menu" }).click();
    await expect.poll(async () => (await menu.boundingBox())?.width ?? 0).toBeGreaterThan(200);
  });

  test("a click on the empty part of the icon strip widens it", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"), { menuCollapsed: true });
    const menu = page.locator("#app-sidebar");
    await expect.poll(async () => (await menu.boundingBox())?.width ?? 999).toBeLessThan(90);
    const box = await menu.boundingBox();
    await page.mouse.click((box?.x ?? 0) + 3, (box?.y ?? 0) + (box?.height ?? 600) - 20);
    await expect.poll(async () => (await menu.boundingBox())?.width ?? 0).toBeGreaterThan(200);
  });

  test("collapsed, hovering a group shows its pages beside the strip", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"), { menuCollapsed: true });
    const menu = page.locator("#app-sidebar");
    await menu.getByRole("link", { name: "Employees" }).first().hover();
    const fly = page.getByRole("group", { name: "Employees pages" });
    await expect(fly).toBeVisible();
    await expect(fly.getByRole("link", { name: "Directory" })).toBeVisible();
    await fly.getByRole("link", { name: "Directory" }).click();
    await expect(page).toHaveURL(/employees/);
  });

  test("Ctrl+B collapses and widens the menu", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    const menu = page.locator("#app-sidebar");
    await page.keyboard.press("Control+b");
    await expect.poll(async () => (await menu.boundingBox())?.width ?? 999).toBeLessThan(90);
    await page.keyboard.press("Control+b");
    await expect.poll(async () => (await menu.boundingBox())?.width ?? 0).toBeGreaterThan(200);
  });

  test("groups stay folded until you are inside them or open them", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    const menu = page.locator("#app-sidebar");
    await expect(menu.getByRole("link", { name: "Directory" })).toHaveCount(0);
    await menu.getByRole("button", { name: "Expand Employees" }).click();
    await expect(menu.getByRole("link", { name: "Directory" })).toBeVisible();
    await menu.getByRole("button", { name: "Collapse Employees" }).click();
    await expect(menu.getByRole("link", { name: "Directory" })).toHaveCount(0);
  });

  test("on a phone-width screen the menu is a drawer that closes after a choice, on Escape and on a tap outside", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await loginToApp(page, getSharedSession("hr_admin"));
    const menu = page.locator("#app-sidebar");
    await expect(menu).toHaveCount(0);
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(menu).toBeVisible();
    await menu.getByRole("link", { name: "Employees" }).first().click();
    await expect(menu).toHaveCount(0);

    await page.getByRole("button", { name: "Open menu" }).click();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await page.getByRole("button", { name: "Open menu" }).click();
    await page.mouse.click(370, 500);
    await expect(menu).toHaveCount(0);
  });
});
