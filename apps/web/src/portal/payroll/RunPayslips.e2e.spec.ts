import { test, expect } from "@playwright/test";
import { createHrAdminSession, loginToApp, API_BASE_URL } from "../../e2e-support/real-session";

/** HR sees every employee's payslips of a run in the Payroll page, with employee number and name; their own pay is elsewhere. */
test("HR sees each employee's payslip with number and name, searches and opens it", async ({ page }) => {
  const hr = await createHrAdminSession();
  const h = { Authorization: `Bearer ${hr.token}`, "Content-Type": "application/json" };
  const stamp = Date.now();
  const make = async (firstName: string, salary: number) => {
    const e = await (await fetch(`${API_BASE_URL}/employees`, { method: "POST", headers: h, body: JSON.stringify({ firstName, lastName: "Payee", email: `${firstName.toLowerCase()}${stamp}@example.com`, dateOfJoining: "2025-01-01" }) })).json();
    await fetch(`${API_BASE_URL}/employees/compensation`, { method: "POST", headers: h, body: JSON.stringify({ employeeId: e.id, monthlySalary: salary, effectiveFrom: "2025-01-01" }) });
    return e as { id: string; employeeNumber: string };
  };
  const zed = await make("Zed", 100000);
  await make("Amna", 150000);
  const run = await (await fetch(`${API_BASE_URL}/payroll/runs`, { method: "POST", headers: h, body: JSON.stringify({ periodStart: "2026-11-01", periodEnd: "2026-11-30" }) })).json();
  await fetch(`${API_BASE_URL}/payroll/runs/${run.id}/calculate`, { method: "POST", headers: h, body: "{}" });

  await loginToApp(page, hr.token);
  await page.goto("/app/payroll");
  const panel = page.getByTestId("run-payslips-panel");
  await expect(panel.getByTestId("run-payslip-row")).toHaveCount(2);
  await expect(panel).toContainText(zed.employeeNumber);
  await expect(panel).toContainText("Zed Payee");
  await expect(panel).toContainText("Amna Payee");

  await page.getByLabel("Search by employee number or name").fill("amna");
  await expect(panel.getByTestId("run-payslip-row")).toHaveCount(1);
  await expect(panel).not.toContainText("Zed Payee");
  await page.getByLabel("Search by employee number or name").fill(zed.employeeNumber);
  await expect(panel.getByTestId("run-payslip-row")).toHaveCount(1);

  await panel.getByRole("link", { name: /Open paystub of/ }).click();
  await expect(page).toHaveURL(/\/app\/payroll\/paystub\//);
  await expect(page.getByRole("link", { name: "Payroll" }).first()).toBeVisible();
});
