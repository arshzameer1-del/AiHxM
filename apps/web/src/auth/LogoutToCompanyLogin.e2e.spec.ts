import { test, expect } from "@playwright/test";
import { createHrAdminSession } from "../e2e-support/real-session";

/**
 * "Log out" from a company's portal ends on that company's own login page (/<slug>/login), never on the shared
 * /login page - even when screens that were still waiting on the server get a 401 after the token is gone.
 */
test("logout lands on the company login page, also while requests are still pending", async ({ page }) => {
  const s = await createHrAdminSession();
  await page.goto("/login");
  await page.evaluate((t) => localStorage.setItem("aihxm.platformAdminToken", t), s.token);

  // Once armed, requests are held until the person has logged out and then refused (401): exactly what a request that
  // was still in flight at the moment of logout looks like.
  let armed = false;
  let loggedOut = false;
  let held = 0;
  await page.route(/\/(employees|attendance|timesheet|leave)/, async (route) => {
    if (!armed || !["fetch", "xhr"].includes(route.request().resourceType())) return route.continue();
    held += 1;
    while (!loggedOut) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Unauthorized" }) }).catch(() => {});
  });

  await page.goto("/app");
  await page.waitForSelector("nav");
  armed = true;
  await page.locator("nav").getByRole("link", { name: "Employees" }).first().click();
  await expect.poll(() => held).toBeGreaterThan(0);
  await page.getByText(/E2E HR Admin/).locator("visible=true").first().click();
  await page.getByRole("button", { name: /log ?out|sign ?out/i }).first().click();
  loggedOut = true;

  await expect(page).toHaveURL(new RegExp(`/${s.companySlug}/login$`));
  // Wait out the delayed 401s: the person must still be on the company login page afterwards.
  await page.waitForTimeout(2500);
  await expect(page).toHaveURL(new RegExp(`/${s.companySlug}/login$`));
});
