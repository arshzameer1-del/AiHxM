import { expect, test } from "@playwright/test";
import { createHrAdminSession, loginToApp } from "../../e2e-support/real-session";

/** The payroll page is split into tabs by kind of work; deep links to a section open the tab that holds it. Real API. */
let hrToken = "";

test.beforeAll(async () => {
  hrToken = (await createHrAdminSession()).token;
});

test("opens on Run payroll and each tab shows only its own sections", async ({ page }) => {
  await loginToApp(page, hrToken);
  await page.goto("/app/payroll");
  const tabs = page.getByRole("tablist", { name: "Payroll areas of work" });
  await expect(tabs.getByRole("tab")).toHaveText(["Run payroll", "Pay inputs", "Settlements", "Payments & accounting", "Setup"]);
  await expect(tabs.getByRole("tab", { name: "Run payroll" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Payroll Dashboard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Settings & Tax Slabs" })).toHaveCount(0);

  await tabs.getByRole("tab", { name: "Setup" }).click();
  await expect(page).toHaveURL(/tab=setup/);
  await expect(page.getByRole("heading", { name: "Payroll Areas" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Settings & Tax Slabs" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payroll Dashboard" })).toHaveCount(0);

  await tabs.getByRole("tab", { name: "Payments & accounting" }).click();
  await expect(page.getByRole("heading", { name: "Accounting & Costing" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payment File Layouts" })).toBeVisible();

  // keyboard: arrow keys move between tabs
  await tabs.getByRole("tab", { name: "Payments & accounting" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");
});

test("a deep link to a section opens its tab and the section", async ({ page }) => {
  await loginToApp(page, hrToken);
  await page.goto("/app/payroll?section=tax-slabs");
  await expect(page.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Settings & Tax Slabs" })).toBeVisible();
  await page.screenshot({ path: "/tmp/payroll-tabs-setup.png", fullPage: false });
});
