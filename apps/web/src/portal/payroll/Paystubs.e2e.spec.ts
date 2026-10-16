import { test, expect, Page, Route } from "@playwright/test";
import type { MeResponse, PayslipDetailView, PayslipView } from "@aihxm/shared-types";

/**
 * My Paystubs (the SAP Fiori "My Paystubs" look): grouped table, search, sort, group, columns, export, row actions,
 * and the paystub sheet. Every /api call is answered by an in-memory mock, so only the Vite dev server is needed.
 */

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";

function slip(id: string, over: Partial<PayslipView>): PayslipView {
  return {
    id,
    companyId: COMPANY_ID,
    payrollRunId: `run-${id}`,
    payrollRunPeriodStart: "2026-06-01",
    payrollRunPeriodEnd: "2026-06-30",
    payrollRunType: "regular",
    payrollRunFinalizedAt: "2026-06-25T09:00:00.000Z",
    employeeId: "e1",
    employeeNumber: "EMP-0001",
    bankAccountNumber: null,
    daysInPeriod: 30,
    paidDays: 30,
    unpaidLeaveDays: 0,
    grossPay: 164826.74,
    taxableGrossThisPeriod: 164826.74,
    taxableAnnualIncome: 0,
    incomeTaxMonthly: 0,
    eobiEmployeeContribution: 0,
    eobiEmployerContribution: 0,
    socialSecurityEmployerContribution: 0,
    netPay: 163031.54,
    calculationBreakdown: [],
    loanDeductions: [],
    consumedAdditionalPayments: [],
    consumedOffCyclePayments: [],
    consumedOvertime: [],
    createdAt: "2026-06-25T09:00:00.000Z",
    updatedAt: "2026-06-25T09:00:00.000Z",
    ...over,
  } as PayslipView;
}

const SLIPS: PayslipView[] = [
  slip("p1", {}),
  slip("p2", { payrollRunPeriodStart: "2026-05-01", payrollRunPeriodEnd: "2026-05-31", payrollRunFinalizedAt: "2026-05-26T09:00:00.000Z", grossPay: 150000, netPay: 140000 }),
  slip("p3", { payrollRunPeriodStart: "2025-12-01", payrollRunPeriodEnd: "2025-12-31", payrollRunFinalizedAt: "2025-12-24T09:00:00.000Z", grossPay: 120000, netPay: 110000 }),
];

const DETAIL: PayslipDetailView = {
  payslipId: "p1",
  payrollRunId: "run-p1",
  employeeId: "e1",
  status: "final",
  isImmutable: true,
  calculationSequence: 1,
  employerCost: 0,
  consumptions: null,
  inputSnapshot: null,
  inputSnapshotHash: null,
  components: [
    { lineNo: 1, key: "basic", label: "Basic salary", category: "earning", affects: "gross", amount: 164826.74, isTaxable: true, quantity: null, unit: null, rate: null, basisAmount: null, sourceType: "rule", sourceId: null, isOverridden: false, trace: {} },
    { lineNo: 2, key: "tax", label: "Income tax", category: "tax", affects: "net", amount: -1795.2, isTaxable: false, quantity: null, unit: null, rate: null, basisAmount: null, sourceType: "rule", sourceId: null, isOverridden: false, trace: {} },
  ],
};

async function mockApi(page: Page) {
  await page.addInitScript(() => localStorage.setItem("aihxm.platformAdminToken", "e2e-token"));
  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path === "/auth/me") {
      const me: MeResponse = {
        isPlatformAdmin: false,
        companyId: COMPANY_ID,
        companyName: "Acme Textiles",
        companySlug: "acme",
        email: "e@acme.test",
        fullName: "Test Employee",
        roleKeys: ["employee_self_service"] as MeResponse["roleKeys"],
        employeeId: "e1",
        enabledModules: ["employee", "payroll"] as MeResponse["enabledModules"],
      };
      return json(me);
    }
    if (path === "/payslips") return json(SLIPS);
    if (path === "/payroll/my-documents") return json([]);
    const detail = path.match(/^\/payslips\/([^/]+)\/detail$/);
    if (detail) return json({ ...DETAIL, payslipId: detail[1] });
    const one = path.match(/^\/payslips\/([^/]+)$/);
    if (one) return json(SLIPS.find((s) => s.id === one[1]) ?? {}, SLIPS.some((s) => s.id === one[1]) ? 200 : 404);
    return json({ message: "Not mocked" }, 404);
  });
}

test.describe("My Paystubs", () => {
  test("lists paystubs grouped by payroll year with readable dates and coloured amounts", async ({ page }) => {
    await mockApi(page);
    await page.goto("/app/payroll");
    await expect(page.getByTestId("paystub-count")).toHaveText("Items (3)");
    await expect(page.getByText("Payroll Year: 2026")).toBeVisible();
    await expect(page.getByText("Payroll Year: 2025")).toBeVisible();
    const first = page.getByTestId("paystub-row").first();
    await expect(first).toContainText("25 Jun 2026");
    await expect(first).toContainText("Regular payroll run");
    await expect(first).toContainText("Jun 2026");
    await expect(first).toContainText("164,826.74");
    await expect(first).toContainText("-Rs");
    await expect(first.locator("td.text-danger")).toBeVisible();
    await expect(first.locator("td.text-success")).toBeVisible();
  });

  test("search narrows the list, group toggle removes the year headings, columns can be hidden", async ({ page }) => {
    await mockApi(page);
    await page.goto("/app/payroll");
    await page.getByLabel("Search Paystubs").fill("2025");
    await expect(page.getByTestId("paystub-count")).toHaveText("Items (1)");
    await page.getByLabel("Search Paystubs").fill("");
    await page.getByRole("button", { name: /Group by payroll year/ }).click();
    await expect(page.getByText("Payroll Year: 2026")).toHaveCount(0);
    await page.getByRole("button", { name: "Personalize the table appearance" }).click();
    await page.locator("#paystub-col-payrollType").uncheck();
    await expect(page.getByRole("columnheader", { name: "Payroll Type" })).toHaveCount(0);
  });

  test("sort by take home pay ascending puts the smallest first", async ({ page }) => {
    await mockApi(page);
    await page.goto("/app/payroll");
    await page.getByRole("button", { name: "Sort your paystubs" }).click();
    await page.getByRole("menuitemradio", { name: "Take Home Pay" }).click();
    await page.getByRole("menuitemradio", { name: "Ascending" }).click();
    await expect(page.getByTestId("paystub-row").first()).toContainText("110,000.00");
  });

  test("a row opens the paystub sheet with earnings, deductions and take home pay", async ({ page }) => {
    await mockApi(page);
    await page.goto("/app/payroll");
    await page.getByTestId("paystub-row").first().click();
    await expect(page).toHaveURL(/\/app\/payroll\/paystub\/p1$/);
    const sheet = page.getByTestId("paystub-sheet");
    await expect(sheet).toContainText("Acme Textiles");
    await expect(sheet).toContainText("EMP-0001");
    await expect(sheet).toContainText("Basic salary");
    await expect(sheet).toContainText("Income tax");
    await expect(sheet).toContainText("163,031.54");
    await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Print" })).toBeVisible();
  });

  test("export to spreadsheet downloads a csv of the visible rows", async ({ page }) => {
    await mockApi(page);
    await page.goto("/app/payroll");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export to Spreadsheet" }).click()]);
    expect(download.suggestedFilename()).toBe("my-paystubs.csv");
  });
});
