import { expect, test, type Page } from "@playwright/test";
import { generate as generateTotp } from "otplib";
import { API_BASE_URL, createHrAdminSession, loginToApp } from "../../e2e-support/real-session";

/**
 * LV-UP: the SAP-style "My Leave Request" screen against the real API. One company, one manager, one staff
 * member (browser session) and a teammate (seeded through HR, never logs in), with the leave policy and the
 * manager-approval workflow set up the same way a real tenant would. Dates are computed from today so the
 * spec does not rot.
 */

const PASSWORD = "E2eTestPassw0rd!";
const SHOTS = process.env.LEAVE_SHOTS_DIR;

async function api<T>(path: string, method: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function employeeLogin(slug: string, employeeNumber: string): Promise<string> {
  const login = await api<{ mfaTicket: string; secretForManualEntry: string }>("/auth/login/employee", "POST", { companySlug: slug, employeeNumber, password: PASSWORD });
  const code = await generateTotp({ secret: login.secretForManualEntry });
  return (await api<{ token: string }>("/auth/mfa/enroll/confirm", "POST", { mfaTicket: login.mfaTicket, code })).token;
}

function iso(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** The next Monday that is at least `minDays` away, so every range below is Mon-Wed and has no weekend in it. */
function mondayAfter(minDays: number): string {
  let offset = minDays;
  while (new Date(`${iso(offset)}T00:00:00Z`).getUTCDay() !== 1) offset += 1;
  return iso(offset);
}

function plus(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const monday = mondayAfter(21);
const tuesday = plus(monday, 1);
const wednesday = plus(monday, 2);

let hrToken = "";
let staffToken = "";
let managerToken = "";
let staffEmployeeId = "";
let teammateEmployeeId = "";
let seededRequestId = "";

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const hr = await createHrAdminSession();
  hrToken = hr.token;

  const make = async (firstName: string, lastName: string, roleKeys: string[], managerId?: string) => {
    const emp = await api<{ id: string; employeeNumber: string }>("/employees", "POST", { firstName, lastName, department: "Engineering", email: `lvup-${firstName.toLowerCase()}-${Date.now()}@example.com`, ...(managerId ? { managerId } : {}) }, hrToken);
    await api(`/employees/${emp.id}/account`, "POST", { initialPassword: PASSWORD, roleKeys }, hrToken);
    return emp;
  };

  const manager = await make("Maya", "Manager", ["employee_self_service", "line_manager", "system_admin"]);
  const staff = await make("Sam", "Staff", ["employee_self_service"], manager.id);
  const teammate = await make("Tina", "Teammate", ["employee_self_service"], manager.id);
  staffEmployeeId = staff.id;
  teammateEmployeeId = teammate.id;

  managerToken = await employeeLogin(hr.companySlug, manager.employeeNumber);
  staffToken = await employeeLogin(hr.companySlug, staff.employeeNumber);

  await api("/leave-policies", "POST", { name: "Default Policy", annualLeaveDays: 14, casualLeaveDays: 10, sickLeaveDays: 8, isDefault: true }, hrToken);
  await api(
    "/workflow/templates",
    "POST",
    { key: "leave_request", name: "Leave Approval", objectKey: "leave_request", steps: [{ stepOrder: 1, name: "Manager approves", approvers: [{ approverType: "manager_of_submitter" }] }] },
    managerToken
  );

  // The teammate's approved leave on Tuesday shows up on the team calendar; HR submits it for them and the manager approves it.
  const mate = await api<{ request: { id: string } }>("/leave-requests", "POST", { employeeId: teammate.id, leaveType: "annual", startDate: tuesday, endDate: tuesday }, hrToken);
  await api(`/leave-requests/${mate.request.id}/decision`, "PATCH", { decision: "approved" }, managerToken);

  // The staff member's own pending request, with the teammate as relief person.
  const own = await api<{ request: { id: string } }>(
    "/leave-requests",
    "POST",
    { employeeId: staff.id, leaveType: "annual", startDate: monday, endDate: tuesday, delegateEmployeeId: teammate.id, reason: "Family trip" },
    staffToken
  );
  seededRequestId = own.request.id;
});

test("entitlement, items with approver, and the request detail with approval chain and team calendar", async ({ page }) => {
  await loginToApp(page, staffToken);
  await page.goto("/app/leave/my-requests");

  const entitlement = page.locator("[data-testid='leave-balance-card']");
  await expect(entitlement.getByText("Annual leave").first()).toBeVisible();
  await expect(entitlement.getByText("14").first()).toBeVisible();

  const items = page.locator("[data-testid='leave-requests']");
  await expect(items).toBeVisible();
  const row = items.locator("tbody tr").first();
  await expect(row).toContainText("Annual leave");
  await expect(row).toContainText("Maya Manager");
  await expect(row).toContainText("Pending");
  await expect(row).toContainText("2 Days");

  await row.getByRole("button", { name: "Show details" }).click();
  const detail = page.locator("[data-testid='leave-request-detail']");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Absence Days:");
  await expect(detail).toContainText("Tina Teammate"); // relief person
  await expect(detail.locator("[data-testid='leave-approval-chain']")).toContainText("1st Level Approver");
  await expect(detail.locator("[data-testid='leave-approval-chain']")).toContainText("Maya Manager");

  const team = detail.locator("[data-testid='team-calendar']");
  await expect(team).toBeVisible();
  await expect(team.getByText("Tina Teammate")).toBeVisible();
  await expect(team.getByText("Sam Staff")).toBeVisible();
  await shot(page, "01-detail-team-week");

  await team.getByRole("radio", { name: "1 Month" }).click();
  await expect(team.getByText("Tina Teammate")).toBeVisible();
  await team.getByLabel("Search colleagues").fill("zzz");
  await expect(team.getByText("No colleague is off in this period.")).toBeVisible();
  await team.getByLabel("Search colleagues").fill("tina");
  await expect(team.getByText("Tina Teammate")).toBeVisible();
  await shot(page, "02-team-month-search");
});

test("edit a pending request with the pencil icon", async ({ page }) => {
  await loginToApp(page, staffToken);
  await page.goto("/app/leave/my-requests");
  const items = page.locator("[data-testid='leave-requests']");
  await items.locator("tbody tr").first().getByRole("button", { name: "Edit request" }).click();

  const form = page.getByRole("form", { name: "Edit leave request" });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Start date")).toHaveValue(monday);
  await expect(form.getByLabel("End date")).toHaveValue(tuesday);
  await expect(form.locator("[data-testid='leave-form-approvers']")).toContainText("1st Level Approver");
  await expect(form.locator("[data-testid='leave-consumed-preview']")).toContainText("2 Days will be consumed");
  // An ordinary employee (no HR rights) still gets a relief-person list: their colleagues.
  const relief = form.getByLabel("Relief person (optional)");
  await expect(relief.locator("option", { hasText: "Tina Teammate" })).toHaveCount(1);
  await expect(relief).toHaveValue(/.+/); // the saved relief person is preselected

  await form.getByLabel("End date").fill(wednesday);
  await expect(form.locator("[data-testid='leave-consumed-preview']")).toContainText("3 Days will be consumed");
  await expect(form.getByLabel("Working days")).toHaveValue("3");
  await expect(form.getByLabel("Absence days")).toHaveValue("3");
  await shot(page, "03-edit-form");
  await form.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByRole("form", { name: "Edit leave request" })).toHaveCount(0);
  const row = page.locator("[data-testid='leave-requests'] tbody tr").first();
  await expect(row).toContainText("3 Days");
  await expect(row).toContainText("Pending");

  // The server really changed it, and kept the same request.
  const view = await api<{ id: string; endDate: string; daysRequested: number; delegateEmployeeName: string }>(`/leave-requests/${seededRequestId}`, "GET", undefined, staffToken);
  expect(view.endDate).toBe(wednesday);
  expect(view.daysRequested).toBe(3);
  expect(view.delegateEmployeeName).toBe("Tina Teammate");
});

test("a pending request can no longer be edited once the manager has approved it", async ({ page }) => {
  await api(`/leave-requests/${seededRequestId}/decision`, "PATCH", { decision: "approved" }, managerToken);
  await loginToApp(page, staffToken);
  await page.goto("/app/leave/my-requests");
  const row = page.locator("[data-testid='leave-requests'] tbody tr").first();
  await expect(row).toContainText("Approved");
  await expect(row.getByRole("button", { name: "Edit request" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Request cancellation" })).toBeVisible();
});

test("Show From hides requests that ended before the chosen date", async ({ page }) => {
  await loginToApp(page, staffToken);
  await page.goto("/app/leave/my-requests");
  await expect(page.getByRole("tab", { name: /Items \(1\)/ })).toBeVisible();
  await page.getByLabel("Show requests from").fill(plus(wednesday, 30));
  await expect(page.getByRole("tab", { name: /Items \(0\)/ })).toBeVisible();
  await page.getByLabel("Show requests from").fill(iso(0));
  await expect(page.getByRole("tab", { name: /Items \(1\)/ })).toBeVisible();
});

test("calendar: pick two days to open the create form filled in, then submit", async ({ page }) => {
  await loginToApp(page, staffToken);
  await page.goto("/app/leave/my-requests");
  await page.getByRole("tab", { name: "Calendar" }).click();

  const nextMonday = plus(wednesday, 5);
  const nextTuesday = plus(nextMonday, 1);
  // Walk the two-month calendar forward until both days are on screen.
  for (let i = 0; i < 4 && (await page.getByRole("button", { name: new RegExp(`^${nextMonday.split("-").reverse().join("\\.")}`) }).count()) === 0; i += 1) {
    await page.getByRole("button", { name: "Next month" }).click();
  }
  await page.getByRole("button", { name: new RegExp(`^${nextMonday.split("-").reverse().join("\\.")}`) }).first().click();
  await page.getByRole("button", { name: new RegExp(`^${nextTuesday.split("-").reverse().join("\\.")}`) }).first().click();

  const form = page.getByRole("form", { name: "Create leave request" });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Start date")).toHaveValue(nextMonday);
  await expect(form.getByLabel("End date")).toHaveValue(nextTuesday);
  await expect(form.locator("[data-testid='leave-available-days']")).toContainText("Days available");
  await expect(form.locator("[data-testid='leave-consumed-preview']")).toContainText("2 Days will be consumed");
  await shot(page, "04-create-from-calendar");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  // Saving returns to My Leave Request; its calendar marks the new request and the Items tab lists it too.
  await expect(page).toHaveURL(/\/app\/leave\/my-requests/);
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^${nextMonday.split("-").reverse().join("\\.")}.*Pending`) }).first()).toBeVisible();
  await page.getByRole("tab", { name: /Items/ }).click();
  await expect(page.locator("[data-testid='leave-requests'] tbody tr")).toHaveCount(2);
});

test("HR submits on behalf: Select Employee, banner, then the same screen for that employee", async ({ page }) => {
  await loginToApp(page, hrToken);
  await page.goto("/app/leave");
  await page.getByTestId("tile-on-behalf").click();
  const dialog = page.getByTestId("select-employee-page");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Search employees").fill("tina");
  await expect(dialog.getByRole("button", { name: /Tina Teammate/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Sam Staff/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: /Tina Teammate/ }).click();

  await expect(page.getByText(/You are acting on behalf of employee/)).toContainText("Tina Teammate");
  await expect(page.locator("[data-testid='on-behalf-leave']").getByText("Annual leave").first()).toBeVisible();
  await shot(page, "05-on-behalf");
  await page.getByRole("link", { name: "Stop acting on behalf" }).click();
  await expect(page.getByText(/You are acting on behalf of employee/)).toHaveCount(0);
  expect(teammateEmployeeId).toBeTruthy();
  expect(staffEmployeeId).toBeTruthy();
});
