import { expect, test } from "@playwright/test";
import { generate as generateTotp } from "otplib";
import { API_BASE_URL, createHrAdminSession, loginToApp } from "../../e2e-support/real-session";

/**
 * BACKLOG58 in the browser, against the real API and database: an administrator turns on a short-hours leave type and
 * its rules, an employee requests an hour or two with a start and end time, and the rule builder tests a draft rule.
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

function plus(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
/** A Monday at least three weeks away, so nothing is in the past and no weekend is involved. */
function monday(): string {
  let offset = 21;
  while (new Date(`${plus(offset)}T00:00:00Z`).getUTCDay() !== 1) offset += 1;
  return plus(offset);
}

const day = monday();
function after(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
let hrToken = "";
let staffToken = "";
let staffName = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const hr = await createHrAdminSession();
  hrToken = hr.token;
  const make = async (firstName: string, lastName: string, roleKeys: string[], managerId?: string) => {
    const emp = await api<{ id: string; employeeNumber: string }>("/employees", "POST", { firstName, lastName, department: "Operations", email: `sh-${firstName.toLowerCase()}-${Date.now()}@example.com`, ...(managerId ? { managerId } : {}) }, hrToken);
    await api(`/employees/${emp.id}/account`, "POST", { initialPassword: PASSWORD, roleKeys }, hrToken);
    return emp;
  };
  const manager = await make("Mira", "Manager", ["employee_self_service", "line_manager", "system_admin"]);
  const staff = await make("Sana", "Shorthours", ["employee_self_service"], manager.id);
  staffName = "Sana Shorthours";
  const managerToken = await employeeLogin(hr.companySlug, manager.employeeNumber);
  staffToken = await employeeLogin(hr.companySlug, staff.employeeNumber);

  // The short-hours type is off until an administrator turns it on; its limits are whatever they type.
  const all = await api<Array<{ id: string; code: string }>>("/leave-types?includeInactive=true", "GET", undefined, hrToken);
  const shortLeave = all.find((t) => t.code === "short_leave")!;
  await api(`/leave-types/${shortLeave.id}`, "PATCH", { isActive: true, durationMode: "short_hours", balanceUnit: "hours" }, hrToken);
  await api("/leave-policies", "POST", { name: "Default Policy", annualLeaveDays: 14, casualLeaveDays: 10, sickLeaveDays: 8, isDefault: true, entitlements: [{ leaveType: "short_leave", days: 10 }] }, hrToken);
  await api("/workflow/templates", "POST", { key: "leave_request", name: "Leave Approval", objectKey: "leave_request", steps: [{ stepOrder: 1, name: "Manager approves", approvers: [{ approverType: "manager_of_submitter" }] }] }, managerToken);
  await api("/leave-types/short_leave/duration-settings", "PUT", { validateAgainstSchedule: false, minDurationMinutes: 15, maxDurationMinutes: 180, incrementMinutes: 15 }, hrToken);
  await api("/leave-validation/rules", "POST", {
    code: "over_an_hour", name: "Longer than an hour", validationType: "max_duration_exceeded", severity: "warning", allowProceed: true,
    message: "That is longer than an hour - please confirm it is what you need.", params: { maxMinutes: 60 }, leaveTypes: ["short_leave"], priority: 2000,
  }, hrToken);
});

test("an employee requests a few hours: duration and balance are worked out, a warning needs confirming, a block stops the request", async ({ page }) => {
  await loginToApp(page, staffToken);
  await page.goto("/app/leave/new");
  const form = page.getByRole("form", { name: "Create leave request" });
  await form.locator("#leave-type").selectOption({ label: "Short leave" });
  // a by-the-hour type has no "more than one day" choice
  await expect(form.getByRole("radiogroup", { name: "Request length" })).toHaveCount(0);
  await form.locator("#leave-start").fill(day);
  await form.locator("#leave-start-time").fill("10:00");
  await form.locator("#leave-end-time").fill("11:00");
  await expect(form.getByTestId("leave-duration")).toHaveValue("1 h");
  await expect(form.getByTestId("leave-timed-summary")).toContainText("1 Hour will be deducted");
  await expect(form.getByTestId("leave-timed-summary")).toContainText("10 Hours available");
  await expect(form.getByTestId("leave-validation-warning")).toHaveCount(0);

  // 75 minutes is over the hour the warning rule talks about
  await form.locator("#leave-end-time").fill("11:15");
  await expect(form.getByTestId("leave-duration")).toHaveValue("1 h 15 min");
  const warning = form.getByTestId("leave-validation-warning");
  await expect(warning).toContainText("longer than an hour");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("alert").first()).toBeVisible(); // refused until the warning is confirmed
  await expect(page).toHaveURL(/\/app\/leave\/new/);
  await warning.getByRole("checkbox").check();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).not.toHaveURL(/\/app\/leave\/new/);

  await page.goto("/app/leave/my-requests");
  const row = page.locator("[data-testid='leave-requests'] tbody tr").first();
  await expect(row).toContainText("Short leave");
  await expect(row).toContainText("10:00 – 11:15 (1 h 15 min)");
  await expect(row).toContainText("1.25 Hours");

  // the same hours again overlap the request that is already waiting
  await page.goto("/app/leave/new");
  const again = page.getByRole("form", { name: "Create leave request" });
  await again.locator("#leave-type").selectOption({ label: "Short leave" });
  await again.locator("#leave-start").fill(day);
  await again.locator("#leave-start-time").fill("10:30");
  await again.locator("#leave-end-time").fill("11:00");
  await expect(again.getByTestId("leave-validation-block").first()).toContainText(/overlapping/i);
  // and four hours is over the longest request the type allows
  await again.locator("#leave-start").fill(after(day, 7));
  await again.locator("#leave-start-time").fill("09:00");
  await again.locator("#leave-end-time").fill("13:00");
  await expect(again.getByTestId("leave-field-block").filter({ hasText: /cannot exceed/i }).first()).toBeVisible();
});

test("an administrator reads the built-in rules, tests a draft rule and saves it, and edits a leave type's timing rules", async ({ page }) => {
  await loginToApp(page, hrToken);
  await page.goto("/app/admin?tab=leaverules");
  const panel = page.getByTestId("leave-rules-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator("[data-testid^='rule-row-']")).toHaveCount(21); // 20 built-in + the one made above
  await expect(panel.getByTestId("rule-row-over_an_hour")).toContainText("Warning");
  // a safety check cannot be switched off
  await expect(panel.getByRole("checkbox", { name: /Insufficient balance active/i })).toBeDisabled();

  await panel.getByRole("button", { name: "New rule" }).click();
  const editor = page.getByTestId("rule-editor");
  await editor.getByLabel("Rule name").fill("Ninety minute cap");
  await editor.getByLabel("What it checks").selectOption("max_duration_exceeded");
  await editor.getByLabel("When it fails").selectOption("warning");
  await editor.getByLabel("Message the employee sees").fill("More than 90 minutes needs a good reason.");
  await editor.getByLabel("Longest request (minutes)").fill("90");
  await editor.getByLabel("Short leave").check();
  // a condition from the lists: duration is more than 30 minutes
  await editor.getByRole("button", { name: "+ Add condition" }).click();
  await editor.getByLabel("Condition 1 operator").selectOption("gt");
  await editor.getByLabel("Condition 1 value").fill("30");
  await expect(editor.getByTestId("condition-sentence")).toContainText("Duration (minutes) is more than 30");

  // try it on a sample request before saving
  const preview = editor.getByTestId("rule-preview");
  const options = await preview.getByLabel("Employee").locator("option").allTextContents();
  await preview.getByLabel("Employee").selectOption({ label: options.find((o) => o.includes(staffName))! });
  await preview.getByLabel("Leave type").selectOption({ label: "Short leave" });
  await preview.getByLabel("Date").fill(after(day, 14));
  await preview.getByLabel("Length").selectOption("hours");
  await preview.getByLabel("Start time").fill("10:00");
  await preview.getByLabel("End time").fill("11:45");
  await preview.getByRole("button", { name: "Run test" }).click();
  await expect(preview.getByTestId("preview-verdict")).toContainText("fires");
  await expect(preview.getByTestId("preview-with")).toContainText("90");

  await editor.getByRole("button", { name: "Create rule" }).click();
  await expect(panel.getByTestId("rule-row-ninety_minute_cap")).toBeVisible();
  await expect(panel.locator("[data-testid^='rule-row-']")).toHaveCount(22);

  // the leave type's own timing rules
  await page.goto("/app/admin?tab=leavetypes");
  await page.getByRole("button", { name: "Timing rules" }).first().click();
  const timing = page.getByTestId("duration-settings-form").first();
  await expect(timing.getByLabel("Longest request (minutes)")).toHaveValue("180");
  await timing.getByLabel("Longest request (minutes)").fill("120");
  await timing.getByRole("button", { name: "Save timing rules" }).click();
  await expect(timing.getByRole("status")).toContainText("Saved (version 2)");
});
