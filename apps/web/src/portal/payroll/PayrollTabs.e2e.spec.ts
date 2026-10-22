import { expect, test } from "@playwright/test";
import { API_BASE_URL, createHrAdminSession, loginToApp } from "../../e2e-support/real-session";

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

test("the month card follows the newest run: first no payroll, then Calculate, then Review", async ({ page }) => {
  await loginToApp(page, hrToken);
  await page.goto("/app/payroll");
  await expect(page.getByTestId("month-card")).toContainText("No payroll has been run yet");

  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${API_BASE_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${hrToken}` }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text}`);
    return JSON.parse(text);
  };
  const e = await call("/employees", { firstName: "Month", lastName: "Card", dateOfJoining: "2020-01-01" });
  await call("/employees/compensation", { employeeId: e.id, monthlySalary: 120000, effectiveFrom: "2020-01-01" });
  const run = await call("/payroll/runs", { periodStart: "2026-10-01", periodEnd: "2026-10-31" });

  await page.reload();
  const card = page.getByTestId("month-card");
  await expect(card).toContainText("1 Oct 2026");
  await expect(card.getByRole("listitem").filter({ hasText: "Prepare" })).toHaveAttribute("aria-current", "step");
  await expect(page.getByTestId("month-next")).toContainText("Pre-validate");

  await call(`/payroll/runs/${run.id}/calculate`, {});
  await page.reload();
  await expect(page.getByTestId("month-card").getByRole("listitem").filter({ hasText: "Review" })).toHaveAttribute("aria-current", "step");
  await expect(page.getByTestId("month-next")).toContainText("Review who moved");
});
