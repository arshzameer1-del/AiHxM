import { expect, test } from "@playwright/test";
import { createHrAdminSession, loginToApp } from "../e2e-support/real-session";

/** Data warmed in the background is used when a screen opens (no second request). Real API. */
test("a screen opens from data the background warm-up already loaded", async ({ page }) => {
  const hr = await createHrAdminSession();
  const employeeCalls: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (r.method() === "GET" && u.pathname === "/api/employees") employeeCalls.push(u.pathname);
  });
  await loginToApp(page, hr.token);
  // The background warm-up reads the employee list once.
  await expect.poll(() => employeeCalls.length).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  const afterWarmup = employeeCalls.length;

  await page.getByRole("link", { name: "Employees", exact: true }).first().click();
  await expect(page.getByRole("heading").first()).toBeVisible();
  await page.waitForTimeout(800);
  expect(employeeCalls.length).toBe(afterWarmup); // opened from what was already loaded

});

/** Switching to another tab and coming back: the data kept loading in the background, so the screen has it at once. */
test("data stays fresh while the tab is in the background and is brought up to date when the tab is shown again", async ({ page }) => {
  const hr = await createHrAdminSession();
  const employeeCalls: number[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (r.method() === "GET" && u.pathname === "/api/employees") employeeCalls.push(Date.now());
  });
  await page.clock.install();
  await page.clock.resume(); // time flows normally; we jump it forward below
  await loginToApp(page, hr.token);
  await expect.poll(() => employeeCalls.length).toBeGreaterThan(0);

  // The person switches to another tab.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1500); // let the first warm-up finish
  const beforeHidden = employeeCalls.length;
  await page.clock.fastForward(65_000); // one minute passes while the tab is in the background
  await expect.poll(() => employeeCalls.length, { message: "refreshed again while hidden" }).toBeGreaterThan(beforeHidden);

  // ...and comes back: everything is brought up to date right away.
  await page.waitForTimeout(1500);
  await page.clock.fastForward(30_000);
  const hiddenTotal = employeeCalls.length;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => employeeCalls.length, { message: "brought up to date on return" }).toBeGreaterThan(hiddenTotal);
});
