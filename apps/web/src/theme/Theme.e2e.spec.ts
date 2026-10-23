import { expect, test, type Page } from "@playwright/test";
import { createHrAdminSession, loginToApp } from "../e2e-support/real-session";

/**
 * Theme switcher: "AiHxM Standard" (default, purple top bar), "AiHxM Enterprise" (dark sidebar) and "BoostFactor" (iOS style,
 * white sidebar, pill buttons). The choice sits in the account menu and survives a reload.
 */

const SHOTS = process.env.THEME_SHOTS_DIR;
let token = "";

test.beforeAll(async () => {
  token = (await createHrAdminSession()).token;
});

const bg = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);

async function chooseTheme(page: Page, label: string) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(label) }).click();
  await page.keyboard.press("Escape");
}

test("starts on AiHxM Standard, switches to Enterprise and BoostFactor and back, and remembers the choice", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginToApp(page, token);
  await page.goto("/app");

  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "onexd");
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(page.getByRole("menuitemradio", { name: /AiHxM Standard/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menuitemradio", { name: /One exD/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await chooseTheme(page, "AiHxM Enterprise");
  await expect(html).toHaveAttribute("data-theme", "enterprise");
  expect(await bg(page, "aside")).toBe("rgb(15, 23, 42)");
  expect(await bg(page, "body")).toBe("rgb(248, 250, 252)");
  await page.screenshot({ path: SHOTS ? `${SHOTS}/home-enterprise.png` : undefined });

  await chooseTheme(page, "BoostFactor");
  await expect(html).toHaveAttribute("data-theme", "boostfactor");
  expect(await bg(page, "aside")).toBe("rgb(255, 255, 255)");
  expect(await bg(page, "body")).toBe("rgb(242, 242, 247)");
  // The nav link fades its colour in, so wait for the final value.
  await expect
    .poll(() => page.locator("aside a[aria-current='page']").first().evaluate((el) => getComputedStyle(el).color))
    .toBe("rgb(0, 122, 255)");
  await page.screenshot({ path: SHOTS ? `${SHOTS}/home-boostfactor.png` : undefined });

  // Moving around inside the app keeps the choice.
  await page.locator("aside").getByRole("link", { name: "Organization", exact: true }).click();
  await expect(page.getByRole("treegrid", { name: "Staff assignments (structure)" })).toBeVisible();
  await expect(html).toHaveAttribute("data-theme", "boostfactor");
  // Primary buttons are pills in this theme.
  const radius = await page.getByRole("button", { name: "New root unit" }).evaluate((el) => getComputedStyle(el).borderRadius);
  expect(radius).not.toBe("");
  await page.screenshot({ path: SHOTS ? `${SHOTS}/organization-boostfactor.png` : undefined });

  await page.screenshot({ path: SHOTS ? `${SHOTS}/organization-boostfactor-pills.png` : undefined });
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(page.getByRole("menuitemradio", { name: /BoostFactor/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: /AiHxM Standard/ }).click();
  await expect(html).toHaveAttribute("data-theme", "onexd");
  expect(await bg(page, "header")).toBe("rgb(113, 99, 158)");
});

test("the saved choice applies on a fresh page load", async ({ page }) => {
  await loginToApp(page, token);
  await page.evaluate(() => localStorage.setItem("aihxm.theme", "boostfactor"));
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "boostfactor");
  await expect.poll(() => bg(page, "body")).toBe("rgb(242, 242, 247)");
});

test("an unknown saved theme falls back to AiHxM Standard", async ({ page }) => {
  await loginToApp(page, token);
  await page.evaluate(() => localStorage.setItem("aihxm.theme", "neon"));
  await page.goto("/app");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "onexd");
});

test("AiHxM Standard theme: purple top bar, warm page, light sidebar, readable account menu", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginToApp(page, token);
  await page.goto("/app");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "onexd");
  expect(await bg(page, "header")).toBe("rgb(113, 99, 158)");
  expect(await bg(page, "body")).toBe("rgb(246, 243, 244)");
  await expect.poll(() => bg(page, "aside")).toBe("rgb(253, 252, 253)");
  await page.screenshot({ path: SHOTS ? `${SHOTS}/home-onexd.png` : undefined });
  await page.getByRole("button", { name: "Account menu" }).click();
  const menu = page.locator(".app-topbar-menu");
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
  await page.screenshot({ path: SHOTS ? `${SHOTS}/menu-onexd.png` : undefined });
});

test("AiHxM Standard home: workspace header and coloured tiles", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginToApp(page, token);
  await page.evaluate(() => localStorage.setItem("aihxm.theme", "onexd"));
  await page.goto("/app");
  const hero = page.getByRole("region", { name: "My workspace" });
  await expect(hero).toBeVisible();
  await expect(hero.getByText("Today")).toBeVisible();
  await expect(hero.getByText("Work email")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Good to see you/ })).toHaveCount(0);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: SHOTS ? `${SHOTS}/home-onexd-full.png` : undefined });
});
