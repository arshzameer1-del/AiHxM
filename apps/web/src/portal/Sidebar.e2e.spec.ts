import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../e2e-support/real-session";

/**
 * Side menu: slim rail (icon with its label underneath), closed until the 3-line button is used,
 * and a pin that keeps it docked beside the page.
 */
test.describe("Side menu", () => {
  test("is closed by default and opens from the 3-line button", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"), { menuPinned: false });
    const menu = page.locator("#app-sidebar");
    await expect(menu).toHaveCount(0);
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("link", { name: "Employees" }).first()).toBeVisible();
    // Narrow rail, not a wide panel.
    const box = await menu.boundingBox();
    expect(box?.width ?? 999).toBeLessThan(120);
  });

  test("a floating menu closes after choosing a page, on Escape and on a click outside", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"), { menuPinned: false });
    const menu = page.locator("#app-sidebar");

    await page.getByRole("button", { name: "Open menu" }).click();
    await menu.getByRole("link", { name: "Employees" }).first().click();
    await expect(menu).toHaveCount(0);

    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await page.getByRole("button", { name: "Open menu" }).click();
    await page.mouse.click(900, 500);
    await expect(menu).toHaveCount(0);
  });

  test("pin keeps the menu open, remembers it, and unpin leaves it floating", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"), { menuPinned: false });
    const menu = page.locator("#app-sidebar");

    await page.getByRole("button", { name: "Pin menu open" }).click();
    await expect(menu).toBeVisible();
    await menu.getByRole("link", { name: "Employees" }).first().click();
    await expect(menu).toBeVisible();

    await page.reload();
    await expect(page.locator("#app-sidebar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Unpin menu" })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Unpin menu" }).click();
    await expect(menu).toBeVisible(); // still open, now floating
    await menu.getByRole("link", { name: "Employees" }).first().click();
    await expect(menu).toHaveCount(0);

    await page.reload();
    await expect(page.locator("#app-sidebar")).toHaveCount(0);
  });

  test("the 3-line button hides a pinned menu and unpins it", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    await expect(page.locator("#app-sidebar")).toBeVisible();
    await page.getByRole("button", { name: "Close menu" }).click();
    await expect(page.locator("#app-sidebar")).toHaveCount(0);
    await page.reload();
    await expect(page.locator("#app-sidebar")).toHaveCount(0);
  });
});
