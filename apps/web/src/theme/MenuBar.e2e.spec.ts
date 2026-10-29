import { expect, test } from "@playwright/test";
import { createHrAdminSession, loginToApp } from "../e2e-support/real-session";

/** "AiHxM Menu Bar" theme: no side menu; a three-line button in the top bar opens the whole menu as a drop-down list. */
let token = "";
test.beforeAll(async () => {
  token = (await createHrAdminSession()).token;
});

test("the three-line button opens the menu list, groups open in place, a choice navigates and closes it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginToApp(page, token);
  await page.goto("/app");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitemradio", { name: /AiHxM Menu Bar/ }).click();
  await page.keyboard.press("Escape");

  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-nav", "dropdown");
  await expect(page.locator("#app-sidebar")).toHaveCount(0);

  const button = page.getByTestId("hamburger-button");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.click();
  const menu = page.getByTestId("hamburger-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");

  // A group (Employees) shows its pages when opened, and the menu stays inside the screen.
  await menu.getByRole("button", { name: /^Employees/ }).click();
  const box = await menu.boundingBox();
  expect(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 900).toBe(true);

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await button.click();
  await page.getByTestId("hamburger-menu").getByRole("link", { name: "Leave Management" }).click();
  await expect(page).toHaveURL(/\/app\/leave/);
  await expect(page.getByTestId("hamburger-menu")).toHaveCount(0);

  // It is remembered across a reload, and the side menu comes back with another theme.
  await page.reload();
  await expect(page.getByTestId("hamburger-button")).toBeVisible();
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitemradio", { name: /AiHxM Standard/ }).click();
  await expect(page.locator("#app-sidebar")).toBeVisible();
  await expect(page.getByTestId("hamburger-button")).toHaveCount(0);
});

test("on a phone the same button works and the list fits the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await loginToApp(page, token);
  await page.addInitScript(() => localStorage.setItem("aihxm.theme", "menubar"));
  await page.goto("/app");
  await page.getByTestId("hamburger-button").click();
  const box = await page.getByTestId("hamburger-menu").boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
