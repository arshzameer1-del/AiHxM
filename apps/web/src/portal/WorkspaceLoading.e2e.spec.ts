import { expect, test } from "@playwright/test";
import { createHrAdminSession } from "../e2e-support/real-session";

/** Right after sign-in a loading screen waits for every screen's data, then the home page opens with it all ready. Real API. */
test("after sign-in the home page waits until the workspace's data is loaded", async ({ page }) => {
  const hr = await createHrAdminSession();
  const employeeCalls: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (r.method() === "GET" && u.pathname === "/api/employees") employeeCalls.push(u.pathname);
  });
  // Slow every data read a little so the loading screen is observable.
  await page.route("**/api/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });

  await page.goto("/login");
  await page.evaluate((token) => {
    // What a real sign-in does: store the session and mark that the first screen should wait for the data.
    localStorage.setItem("aihxm.platformAdminToken", token);
    localStorage.setItem("aihxm.sidebarPinned", "1");
    sessionStorage.setItem("aihxm.loadWorkspaceFor", token.slice(-24));
  }, hr.token);
  await page.goto("/app");

  await expect(page.getByTestId("workspace-loading")).toBeVisible();
  await expect(page.getByText("Preparing your workspace")).toBeVisible();
  // It opens by itself once everything is loaded, and the home page shows.
  await expect(page.getByTestId("workspace-loading")).toHaveCount(0, { timeout: 30000 });
  await page.waitForSelector("nav");
  const loaded = employeeCalls.length;
  expect(loaded).toBeGreaterThan(0);

  // A screen then opens from what was loaded, without asking the server again.
  await page.getByRole("link", { name: "Employees", exact: true }).first().click();
  await expect(page.getByRole("heading").first()).toBeVisible();
  await page.waitForTimeout(800);
  expect(employeeCalls.length).toBe(loaded);

  // A reload of the page is not a new sign-in: no loading screen again.
  await page.reload();
  await page.waitForSelector("nav");
  await expect(page.getByTestId("workspace-loading")).toHaveCount(0);
});
