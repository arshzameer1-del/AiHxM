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
