import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** Reports & Analytics against the real API: library, search, a report run, and the not-yet-available state. */
test.describe("Reports & Analytics", () => {
  test("HR Admin finds a report in the library and runs it", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"), { menuPinned: true });
    await page.getByRole("link", { name: "Reports & Analytics" }).first().click();
    await expect(page.getByRole("heading", { name: "Reports & Analytics" })).toBeVisible();

    await page.getByLabel("Search reports").fill("headcount");
    const first = page.locator("[data-testid^='report-card-']").first();
    await expect(first).toBeVisible();
    await first.getByRole("link").click();

    await expect(page.getByRole("link", { name: "All reports" })).toBeVisible();
    await expect(page.getByText("How is this calculated?")).toBeVisible();
    // A fresh company has no staff: the page says so instead of showing zeros that look like findings.
    await expect(page.getByTestId("report-error")).toHaveCount(0);
  });

  test("a report that needs data we do not capture explains what is missing", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"), { menuPinned: true });
    await page.goto("/app/reports");
    await page.getByLabel("Status", { exact: true }).selectOption("blocked");
    const card = page.locator("[data-testid^='report-card-']").first();
    await expect(card).toBeVisible();
    await card.getByRole("link").click();
    await expect(page.getByTestId("report-unavailable")).toBeVisible();
    await expect(page.getByText("We do not estimate or invent figures.")).toBeVisible();
  });

  test("an unknown report id says so", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"), { menuPinned: true });
    await page.goto("/app/reports/Z99");
    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("an employee does not get the Reports link", async ({ page }) => {
    await loginToApp(page, getSharedSession("employee_self_service"), { menuPinned: true });
    await expect(page.getByRole("link", { name: "Reports & Analytics" })).toHaveCount(0);
  });
});
