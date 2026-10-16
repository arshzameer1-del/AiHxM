import { expect, test } from "@playwright/test";
import { API_BASE_URL, createHrAdminSession, loginToApp } from "../../e2e-support/real-session";

/** Payroll > New run > Selection: HR picks employees by pasting numbers and a payroll area, the run is created with that selection and says so. Real API. */
test.describe.configure({ mode: "serial" });
let hrToken = "";
const numbers: string[] = [];

async function post(path: string, body: unknown): Promise<{ id: string; employeeNumber?: string }> {
  const res = await fetch(`${API_BASE_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${hrToken}` }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text}`);
  return JSON.parse(text);
}

test.beforeAll(async () => {
  hrToken = (await createHrAdminSession()).token;
  for (const name of ["Sana", "Bilal", "Hira"]) {
    const e = await post("/employees", { firstName: name, lastName: "Selection", dateOfJoining: "2020-01-01" });
    numbers.push(e.employeeNumber as string);
    await post("/employees/compensation", { employeeId: e.id, monthlySalary: 90000, effectiveFrom: "2020-01-01" });
  }
  await post("/payroll/areas", { code: "E2E1", name: "E2E selection area" });
});

test("HR creates a run for two pasted employee numbers and the run shows the selection", async ({ page }) => {
  await loginToApp(page, hrToken);
  await page.goto("/app/payroll");
  await page.getByRole("button", { name: "New run" }).click();
  const picker = page.getByTestId("run-selection");
  await expect(picker.getByTestId("selection-summary")).toContainText("pays everyone it covers");

  await picker.getByLabel(/Or paste employee numbers/).fill(`${numbers[0]}, ${numbers[2]} NOPE-1`);
  // The button reads "Loading…" and stays disabled until the employee list has arrived.
  await expect(picker.getByRole("button", { name: "Add", exact: true })).toBeEnabled();
  await picker.getByRole("button", { name: "Add", exact: true }).click();
  await expect(picker.getByRole("status")).toContainText("2 added; not found: NOPE-1");
  await expect(picker.getByTestId("selected-employees")).toContainText(numbers[0]);
  await expect(picker.getByTestId("selected-employees")).toContainText(numbers[2]);
  await expect(picker.getByTestId("selection-summary")).toContainText("2 chosen employees");

  // Removing a chip narrows it again.
  await picker.getByRole("button", { name: `Remove ${numbers[2]}` }).click();
  await expect(picker.getByTestId("selection-summary")).toContainText("1 chosen employee");
  await picker.getByLabel(/Or paste employee numbers/).fill(numbers[1]);
  await picker.getByRole("button", { name: "Add", exact: true }).click();
  await picker.getByRole("group", { name: "Payroll areas" }).getByLabel(/E2E selection area/).check();
  await expect(picker.getByTestId("selection-summary")).toContainText("2 chosen employees and 1 payroll area");

  // The form's date labels are not tied to their inputs, so the two date fields are found by type.
  await page.locator('input[type="date"]').nth(0).fill("2030-03-01");
  await page.locator('input[type="date"]').nth(1).fill("2030-03-31");
  await page.getByRole("button", { name: "Create run" }).click();
  await expect(page.getByTestId("run-selection-badge").first()).toContainText("2 chosen employees and 1 payroll area");
});
