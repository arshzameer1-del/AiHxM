import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../e2e-support/real-session";

/** P5: the language switch in the account menu. Urdu mirrors the page (right to left), translates the menu, and is remembered. */
test.describe("Language", () => {
  test("Urdu turns the page right-to-left with a translated menu, and English brings it back", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    const menu = page.locator("#app-sidebar");
    await expect(menu.getByRole("link", { name: "Employees" }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByTestId("menu-language").getByRole("menuitemradio", { name: "اردو" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ur");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(menu.getByRole("link", { name: "ملازمین" }).first()).toBeVisible();

    // remembered after a reload
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    await page.getByRole("button", { name: "اکاؤنٹ مینو" }).click();
    await page.getByTestId("menu-language").getByRole("menuitemradio", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(menu.getByRole("link", { name: "Employees" }).first()).toBeVisible();
  });
});
