import { expect, test } from "@playwright/test";
import { generate as generateTotp } from "otplib";
import { API_BASE_URL, createHrAdminSession, loginToApp } from "../../e2e-support/real-session";

/**
 * Leave Approvals: what the approver sees before deciding. One company, one manager (browser session), a staff member with a pending
 * request and a teammate whose leave is already approved, with the manager-approval workflow set up like a real tenant.
 */

const PASSWORD = "E2eTestPassw0rd!";

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

let managerToken = "";
let staffName = "";
let staffNumber = "";
let staffRequestId = "";
let mateRequestId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const hr = await createHrAdminSession();
  const hrToken = hr.token;
  const make = async (firstName: string, lastName: string, roleKeys: string[], managerId?: string) => {
    const emp = await api<{ id: string; employeeNumber: string }>("/employees", "POST", { firstName, lastName, department: "Engineering", email: `lvap-${firstName.toLowerCase()}-${Date.now()}@example.com`, ...(managerId ? { managerId } : {}) }, hrToken);
    await api(`/employees/${emp.id}/account`, "POST", { initialPassword: PASSWORD, roleKeys }, hrToken);
    return emp;
  };
  const manager = await make("Maya", "Manager", ["employee_self_service", "line_manager", "system_admin"]);
  const staff = await make("Sam", "Staff", ["employee_self_service"], manager.id);
  const teammate = await make("Tina", "Teammate", ["employee_self_service"], manager.id);
  staffName = "Sam Staff";
  staffNumber = staff.employeeNumber;
  managerToken = await employeeLogin(hr.companySlug, manager.employeeNumber);
  const staffToken = await employeeLogin(hr.companySlug, staff.employeeNumber);

  await api("/leave-policies", "POST", { name: "Default Policy", annualLeaveDays: 14, casualLeaveDays: 10, sickLeaveDays: 8, isDefault: true }, hrToken);
  await api("/workflow/templates", "POST", { key: "leave_request", name: "Leave Approval", objectKey: "leave_request", steps: [{ stepOrder: 1, name: "Manager approves", approvers: [{ approverType: "manager_of_submitter" }] }] }, managerToken);

  const mate = await api<{ request: { id: string } }>("/leave-requests", "POST", { employeeId: teammate.id, leaveType: "annual", startDate: tuesday, endDate: tuesday }, hrToken);
  mateRequestId = mate.request.id;
  await api(`/leave-requests/${mateRequestId}/decision`, "PATCH", { decision: "approved" }, managerToken);
  const own = await api<{ request: { id: string } }>("/leave-requests", "POST", { employeeId: staff.id, leaveType: "annual", startDate: monday, endDate: wednesday, reason: "Family trip" }, staffToken);
  staffRequestId = own.request.id;
});

test("the approver opens on what waits for a decision, with the employee's name and number", async ({ page }) => {
  await loginToApp(page, managerToken);
  await page.goto("/app/leave/approvals");
  await expect(page.getByTestId("leave-filter-waiting")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(staffName)).toBeVisible();
  await expect(page.getByText(staffNumber).first()).toBeVisible();
  await expect(page.getByTestId(`leave-details-${mateRequestId}`)).toHaveCount(0); // already approved: only under All
  await page.getByTestId("leave-filter-all").click();
  await expect(page.getByTestId(`leave-details-${mateRequestId}`)).toBeVisible();
});

test("Details shows the balance, the approval chain, the note and the team calendar", async ({ page }) => {
  await loginToApp(page, managerToken);
  await page.goto("/app/leave/approvals");
  await page.getByTestId(`leave-details-${staffRequestId}`).click();
  const panel = page.getByTestId(`leave-details-panel-${staffRequestId}`);
  await expect(panel.getByTestId("leave-request-detail")).toBeVisible();
  await expect(panel.getByTestId("leave-balance-line")).toContainText("14 entitled");
  await expect(panel.getByTestId("leave-balance-line")).toContainText("11 left after this request");
  await expect(panel.getByTestId("leave-approval-chain")).toContainText("Manager");
  await expect(panel).toContainText("Family trip");
  await expect(panel).toContainText("Working days");
  await page.getByTestId(`leave-details-${staffRequestId}`).click();
  await expect(panel).toHaveCount(0);
});

test("approving from the list moves the request out of the waiting tab", async ({ page }) => {
  await loginToApp(page, managerToken);
  await page.goto("/app/leave/approvals");
  await page.getByRole("button", { name: "Approve", exact: true }).first().click();
  await page.getByRole("button", { name: /Confirm approval/ }).click();
  await expect(page.getByTestId("leave-requests-empty")).toContainText("Nothing is waiting for your decision.");
  await page.getByTestId("leave-filter-all").click();
  await expect(page.getByText(staffName)).toBeVisible();
});
