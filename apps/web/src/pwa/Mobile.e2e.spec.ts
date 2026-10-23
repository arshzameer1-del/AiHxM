import { expect, test, type Browser } from "@playwright/test";
import { createHrAdminSession, loginToApp } from "../e2e-support/real-session";

/**
 * The phone experience: the shell fits a 390 px screen (nothing cut off, no sideways scroll), and the install offer appears on a phone,
 * with the steps on iPhone and the browser's own prompt on Android.
 */
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Mobile Safari/537.36";

async function phone(browser: Browser, userAgent: string) {
  return browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent });
}

let token = "";
test.beforeAll(async () => {
  token = (await createHrAdminSession()).token;
});

test("the top bar and the pages fit a 390 px phone: avatar fully visible, no sideways scroll", async ({ browser }) => {
  const ctx = await phone(browser, ANDROID_UA);
  const page = await ctx.newPage();
  await page.goto("/login");
  await expect(page.locator("body")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  await loginToApp(page, token);
  for (const path of ["/app", "/app/approvals", "/app/attendance/timesheet", "/app/employees", "/app/leave"]) {
    await page.goto(path);
    await page.getByRole("button", { name: "Account menu" }).waitFor();
    const box = await page.getByRole("button", { name: "Account menu" }).boundingBox();
    expect(box && box.x + box.width, `${path}: the account button is inside the screen`).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${path}: no sideways scroll`).toBeLessThanOrEqual(0);
  }
  await ctx.close();
});

test("the side menu opens as a floating drawer on a phone and closes after a choice", async ({ browser }) => {
  const ctx = await phone(browser, ANDROID_UA);
  const page = await ctx.newPage();
  await loginToApp(page, token);
  await page.goto("/app");
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.locator("#app-sidebar")).toBeVisible();
  await page.locator("#app-sidebar a").first().click();
  await expect(page.locator("#app-sidebar")).toHaveCount(0);
  await ctx.close();
});

test("iPhone: the install offer shows the Share > Add to Home Screen steps, and 'not now' is remembered", async ({ browser }) => {
  const ctx = await phone(browser, IPHONE_UA);
  const page = await ctx.newPage();
  await page.goto("/login");
  await expect(page.getByTestId("install-banner")).toBeVisible();
  await page.getByTestId("install-now").click();
  await expect(page.getByTestId("ios-install-help")).toContainText("Add to Home Screen");
  await page.getByRole("button", { name: "Got it" }).click();
  await page.getByTestId("install-dismiss").click();
  await expect(page.getByTestId("install-banner")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: /sign in/i }).first().waitFor();
  await expect(page.getByTestId("install-banner")).toHaveCount(0);
  await ctx.close();
});

test("Android: when the browser offers its install prompt the banner shows Install and uses it", async ({ browser }) => {
  const ctx = await phone(browser, ANDROID_UA);
  const page = await ctx.newPage();
  await page.goto("/login");
  await expect(page.getByTestId("install-banner")).toHaveCount(0); // nothing to offer until the browser says it can
  await page.evaluate(() => {
    const w = window as unknown as { __prompted?: boolean };
    const event = new Event("beforeinstallprompt") as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
    event.prompt = async () => { w.__prompted = true; };
    event.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(event);
  });
  await expect(page.getByTestId("install-banner")).toBeVisible();
  await expect(page.getByTestId("install-now")).toHaveText("Install");
  await page.getByTestId("install-now").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prompted?: boolean }).__prompted)).toBe(true);
  await expect(page.getByTestId("install-banner")).toHaveCount(0);
  await ctx.close();
});

test("a desktop browser is not offered the install banner", async ({ page }) => {
  await page.goto("/login");
  await page.waitForTimeout(500);
  await expect(page.getByTestId("install-banner")).toHaveCount(0);
});

test("offline: a banner says so, and it goes away when the connection returns", async ({ browser }) => {
  const ctx = await phone(browser, ANDROID_UA);
  const page = await ctx.newPage();
  await page.goto("/login");
  await ctx.setOffline(true);
  await expect(page.getByTestId("offline-banner")).toBeVisible();
  await ctx.setOffline(false);
  await expect(page.getByTestId("offline-banner")).toHaveCount(0);
  await ctx.close();
});
