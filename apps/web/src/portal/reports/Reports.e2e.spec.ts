import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** Reports & Analytics against the real API: library, search, a report run, and the not-yet-available state. */
test.describe("Reports & Analytics", () => {
  test("HR Admin finds a report in the library and runs it", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    await page.getByRole("link", { name: "Reports & Analytics" }).first().click();
    await expect(page.getByRole("heading", { name: "Reports & Analytics" })).toBeVisible();
    await page.getByRole("navigation", { name: "Reports & Analytics sections" }).getByRole("link", { name: "Library" }).click();
    await expect(page.getByRole("heading", { name: "Report library" })).toBeVisible();

    await page.getByLabel("Search reports").fill("headcount");
    const first = page.locator("[data-testid^='report-card-']").first();
    await expect(first).toBeVisible();
    await first.getByRole("link").click();

    await expect(page.getByRole("link", { name: "All reports" })).toBeVisible();
    await expect(page.getByText("How is this calculated?")).toBeVisible();
    // A fresh company has no staff: the page says so instead of showing zeros that look like findings.
    await expect(page.getByTestId("report-error")).toHaveCount(0);
  });

  test("a master data report shows its extra tables as tabs", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    await page.goto("/app/reports/B20");
    await expect(page.getByTestId("report-tabs")).toBeVisible();
    await expect(page.getByTestId("report-tab-detail")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("report-tab-family").click();
    await expect(page.getByTestId("report-tab-family")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: /Family members/ })).toBeVisible();
    await page.getByTestId("report-tab-assets-by-type").click();
    await expect(page.getByRole("heading", { name: /Assets by type/ })).toBeVisible();
  });

  test("a report that needs data we do not capture explains what is missing", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    await page.goto("/app/reports/library");
    await page.getByLabel("Status", { exact: true }).selectOption("blocked");
    const card = page.locator("[data-testid^='report-card-']").first();
    await expect(card).toBeVisible();
    await card.getByRole("link").click();
    await expect(page.getByTestId("report-unavailable")).toBeVisible();
    await expect(page.getByText("We do not estimate or invent figures.")).toBeVisible();
  });

  test("every Reports tab opens its page", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    await page.goto("/app/reports");
    const tabs = page.getByRole("navigation", { name: "Reports & Analytics sections" });
    const pages: [string, string][] = [
      ["My reports", "My reports"],
      ["Dashboards", "Dashboards"],
      ["Builder", "Report Builder"],
      ["Scheduled", "Scheduled reports"],
      ["Exports", "My exports"],
    ];
    for (const [tab, heading] of pages) {
      await tabs.getByRole("link", { name: tab, exact: true }).click();
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }
  });

  test("an unknown report id says so", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    await page.goto("/app/reports/Z99");
    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("an employee does not get the Reports link", async ({ page }) => {
    await loginToApp(page, getSharedSession("employee_self_service"));
    await expect(page.getByRole("link", { name: "Reports & Analytics" })).toHaveCount(0);
  });
});
