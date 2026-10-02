import { test, expect, Page, Route } from "@playwright/test";
import type { MeResponse, PayrollAreaView, PayrollRunView } from "@aihxm/shared-types";

/**
 * Payroll Areas E2E Tests (0101_payroll_areas.sql's UI)
 *
 * Covers the Payroll page's Payroll Areas section and the run-creation
 * form's optional area picker:
 * - hr_admin (`payroll_area.manage.all`): list, create, scope-link and
 *   employee-assignment actions, and targeting a run at one area
 * - payroll_approver (list-only): the same list, read-only
 *
 * Unlike the older specs in this folder tree, every `/api/**` call here
 * is answered by an in-memory `page.route()` mock, so this spec needs only
 * the Vite dev server (playwright.config.ts's `webServer`), not a seeded
 * backend — the assertions are on what the UI renders and the exact
 * request bodies it sends (PayrollAreasController's contract).
 */

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const ORG_UNIT_ID = "00000000-0000-4000-8000-0000000000a1";
const LOCATION_ID = "00000000-0000-4000-8000-0000000000b1";
const EMPLOYEE_ID = "00000000-0000-4000-8000-0000000000e1";

function area(overrides: Partial<PayrollAreaView>): PayrollAreaView {
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    companyId: COMPANY_ID,
    code: "KHI-M",
    name: "Karachi Monthly",
    description: "All Karachi staff",
    isActive: true,
    employeeCount: 12,
    scopeLinks: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

type MockState = {
  areas: PayrollAreaView[];
  runs: PayrollRunView[];
  requests: { method: string; path: string; body: unknown }[];
};

function identity(roleKeys: string[]): MeResponse {
  return {
    isPlatformAdmin: false,
    companyId: COMPANY_ID,
    companyName: "Acme Textiles",
    companySlug: "acme",
    email: "admin@acme.test",
    fullName: "Test User",
    roleKeys: roleKeys as MeResponse["roleKeys"],
    employeeId: null,
    enabledModules: ["employee", "payroll"] as MeResponse["enabledModules"],
  };
}

async function mockApi(page: Page, roleKeys: string[], state: MockState) {
  await page.addInitScript(() => localStorage.setItem("aihxm.platformAdminToken", "e2e-token"));

  // A predicate, not a "**/api/**" glob — that glob would also swallow
  // Vite's own `/src/api/client.ts` module request.
  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method();
    const body = req.postData() ? JSON.parse(req.postData() as string) : undefined;
    if (method !== "GET") state.requests.push({ method, path, body });
    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

    if (path === "/auth/me") return json(identity(roleKeys));
    if (path === "/payroll/runs" && method === "GET") return json(state.runs);
    if (path === "/payroll/runs" && method === "POST") {
      const run: PayrollRunView = {
        id: `run-${state.runs.length + 1}`,
        companyId: COMPANY_ID,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        status: "draft",
        workflowInstanceId: null,
        createdByUserAccountId: "u1",
        finalizedAt: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        payslipCount: 0,
        totalGrossPay: 0,
        totalNetPay: 0,
        reversedAt: null,
        reversedByUserAccountId: null,
        reversalReason: null,
        correctiveRunId: null,
        payrollAreaId: body.payrollAreaId ?? null,
      };
      state.runs.push(run);
      return json(run, 201);
    }
    if (path === "/payroll/areas" && method === "GET") {
      const includeInactive = url.searchParams.get("includeInactive") === "true";
      return json(state.areas.filter((a) => includeInactive || a.isActive));
    }
    if (path === "/payroll/areas" && method === "POST") {
      const created = area({
        id: "00000000-0000-4000-8000-0000000000f9",
        code: body.code,
        name: body.name,
        description: body.description,
        employeeCount: 0,
      });
      state.areas.push(created);
      return json(created, 201);
    }
    if (path === "/payroll/areas/employee-assignments") return json(body, 201);
    const linkAdd = path.match(/^\/payroll\/areas\/([^/]+)\/scope-links$/);
    if (linkAdd && method === "POST") {
      const target = state.areas.find((a) => a.id === linkAdd[1])!;
      target.scopeLinks = [
        ...target.scopeLinks,
        { id: `link-${target.scopeLinks.length + 1}`, payrollAreaId: target.id, createdAt: "2026-10-01T00:00:00.000Z", ...body },
      ];
      return json(target, 201);
    }
    if (path === "/organization/units") {
      return json([{ id: ORG_UNIT_ID, companyId: COMPANY_ID, parentId: null, code: "SR", name: "South Region", status: "active" }]);
    }
    if (path === "/organization/locations") {
      return json([{ id: LOCATION_ID, companyId: COMPANY_ID, parentId: null, code: "KHI", name: "Karachi Branch", status: "active" }]);
    }
    if (path === "/organization/cost-centers") return json([]);
    if (path === "/employees") {
      return json([
        { id: EMPLOYEE_ID, employeeNumber: "EMP-001", firstName: "Ayesha", lastName: "Khan", employmentStatus: "active" },
      ]);
    }
    return json({ message: "Not mocked" }, 404);
  });
}

async function openPayrollAreas(page: Page) {
  await page.goto("/app/payroll?section=payroll-areas");
  await expect(page.getByRole("heading", { name: "Payroll", exact: true })).toBeVisible();
  await expect(page.locator("#payroll-areas")).toBeVisible();
}

test.describe("Payroll Areas", () => {
  test("HR Admin sees areas with employee count and scope summary", async ({ page }) => {
    const state: MockState = {
      areas: [
        area({
          scopeLinks: [
            { id: "l1", payrollAreaId: "x", scopeType: "location", scopeEntityId: LOCATION_ID, createdAt: "2026-09-01T00:00:00.000Z" },
          ],
        }),
      ],
      runs: [],
      requests: [],
    };
    await mockApi(page, ["hr_admin"], state);
    await openPayrollAreas(page);

    const section = page.locator("#payroll-areas");
    const row = section.locator("tr", { hasText: "Karachi Monthly" });
    await expect(row).toContainText("KHI-M");
    await expect(row).toContainText("12");
    await expect(row).toContainText("Location: Karachi Branch (KHI)");
    await expect(row.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(section.getByRole("button", { name: "New area" })).toBeVisible();
  });

  test("HR Admin creates an area, links its scope and assigns an employee", async ({ page }) => {
    const state: MockState = { areas: [], runs: [], requests: [] };
    await mockApi(page, ["hr_admin"], state);
    await openPayrollAreas(page);
    const section = page.locator("#payroll-areas");

    await section.getByRole("button", { name: "New area" }).click();
    await section.getByPlaceholder("KHI-M").fill("LHE-W");
    await section.getByPlaceholder("Karachi Monthly").fill("Lahore Weekly");
    await section.getByRole("button", { name: "Create area" }).click();
    await expect(section.locator("tr", { hasText: "Lahore Weekly" })).toBeVisible();
    expect(state.requests).toContainEqual({
      method: "POST",
      path: "/payroll/areas",
      body: { code: "LHE-W", name: "Lahore Weekly", description: null },
    });

    const row = section.locator("tr", { hasText: "Lahore Weekly" });
    await row.getByRole("button", { name: "Scope" }).click();
    await section.locator("select").nth(1).selectOption({ label: "South Region (SR)" });
    await section.getByRole("button", { name: "Add link" }).click();
    await expect(row).toContainText("Org unit: South Region (SR)");
    expect(state.requests).toContainEqual({
      method: "POST",
      path: "/payroll/areas/00000000-0000-4000-8000-0000000000f9/scope-links",
      body: { scopeType: "org_unit", scopeEntityId: ORG_UNIT_ID },
    });

    await row.getByRole("button", { name: "Assign" }).click();
    await section.getByPlaceholder("Filter by name or employee #").fill("ayesha");
    const assignForm = section.locator("form", { hasText: "Assigning replaces" });
    await assignForm.locator("select").first().selectOption({ label: "Ayesha Khan (EMP-001)" });
    await expect(assignForm.locator("select").nth(1)).toHaveValue("00000000-0000-4000-8000-0000000000f9");
    await assignForm.getByRole("button", { name: "Assign", exact: true }).click();
    await expect(section.getByText("Ayesha Khan assigned to Lahore Weekly.")).toBeVisible();
    expect(state.requests).toContainEqual({
      method: "POST",
      path: "/payroll/areas/employee-assignments",
      body: { employeeId: EMPLOYEE_ID, payrollAreaId: "00000000-0000-4000-8000-0000000000f9" },
    });
  });

  test("New run defaults to company-wide and can target one area", async ({ page }) => {
    const state: MockState = { areas: [area({})], runs: [], requests: [] };
    await mockApi(page, ["hr_admin"], state);
    await page.goto("/app/payroll");

    await page.getByRole("button", { name: "New run" }).click();
    const areaSelect = page.locator("form").filter({ hasText: "Payroll area" }).locator("select");
    await expect(areaSelect).toHaveValue("");
    await expect(page.getByText("Everyone employed during the period is included")).toBeVisible();

    await page.locator("input[type=date]").first().fill("2026-10-01");
    await page.locator("input[type=date]").nth(1).fill("2026-10-31");
    await areaSelect.selectOption({ label: "Karachi Monthly (KHI-M) — 12 employees" });
    await page.getByRole("button", { name: "Create run" }).click();

    await expect(page.getByText("Karachi Monthly (KHI-M)").first()).toBeVisible();
    expect(state.requests).toContainEqual({
      method: "POST",
      path: "/payroll/runs",
      body: { periodStart: "2026-10-01", periodEnd: "2026-10-31", payrollAreaId: "00000000-0000-4000-8000-0000000000f1" },
    });
  });

  test("Payroll Approver sees areas read-only", async ({ page }) => {
    const state: MockState = {
      areas: [
        area({
          scopeLinks: [
            { id: "l1", payrollAreaId: "x", scopeType: "org_unit", scopeEntityId: ORG_UNIT_ID, createdAt: "2026-09-01T00:00:00.000Z" },
          ],
        }),
      ],
      runs: [],
      requests: [],
    };
    await mockApi(page, ["payroll_approver"], state);
    await openPayrollAreas(page);
    const section = page.locator("#payroll-areas");

    const row = section.locator("tr", { hasText: "Karachi Monthly" });
    await expect(row).toBeVisible();
    await expect(section.getByRole("button", { name: "New area" })).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Assign employee" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Deactivate" })).toHaveCount(0);

    await row.getByRole("button", { name: "Scope" }).click();
    await expect(section.getByText("South Region (SR)").last()).toBeVisible();
    await expect(section.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Add link" })).toHaveCount(0);
  });
});
