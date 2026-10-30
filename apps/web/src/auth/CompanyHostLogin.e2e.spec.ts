import { test, expect } from "@playwright/test";
import { createHrAdminSession } from "../e2e-support/real-session";

/**
 * A company's own address (<slug>.aihxm.com, here <slug>.localhost) opens that company's sign-in page at plain /login, the
 * same page /<slug>/login shows. A host that names no company says so instead of showing a working-looking form.
 */
test("a company host opens that company's sign-in page", async ({ page }) => {
  const s = await createHrAdminSession();
  await page.goto(`http://${s.companySlug}.localhost:5173/login`);
  await expect(page.getByText("Employee ID / Login ID")).toBeVisible();
  await expect(page.getByPlaceholder(/EMP-0001/)).toBeVisible();
});

test("a host that is not a company shows the not-found card", async ({ page }) => {
  await page.goto("http://no-such-company-zz.localhost:5173/login");
  await expect(page.getByText(/isn.t a company set up on AiHxM/)).toBeVisible();
  await expect(page.getByPlaceholder(/EMP-0001/)).toHaveCount(0);
});

test("the plain address still opens the shared email sign-in", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText("Employee ID / Login ID")).toHaveCount(0);
});
