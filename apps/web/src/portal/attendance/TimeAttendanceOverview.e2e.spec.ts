import { expect, test } from "@playwright/test";
import { API_BASE_URL, createHrAdminSession, createRoleSession, loginToApp } from "../../e2e-support/real-session";
import { todayIso } from "../shared/dates";

/**
 * Time & Attendance overview (rings and hours pipeline), the timesheet page (tiles, progress, approval stepper), the Approvals
 * page and the home Action centre, against the real API: an employee submits a week, HR approves it from Approvals.
 */
test.describe.configure({ mode: "serial" });
let employeeToken = "";
let hrToken = "";
let employeeId = "";

async function call(method: string, path: string, token: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API_BASE_URL}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

test.beforeAll(async () => {
  const hr = await createHrAdminSession();
  hrToken = hr.token;
  employeeToken = await createRoleSession(hr, "employee_self_service");
  const me = await call("GET", "/auth/me", employeeToken);
  employeeId = me.employeeId;
  const shift = await call("POST", "/shifts", hr.token, { name: "General shift", startTime: "09:00", endTime: "18:00", graceMinutesLate: 15, isDefault: true });
  await call("POST", "/shift-assignments", hr.token, { employeeId: me.employeeId, shiftId: shift.id, effectiveFrom: "2020-01-01" });
});

test("Time & Attendance opens on four rings and the hours pipeline", async ({ page }) => {
  await loginToApp(page, employeeToken);
  await page.goto("/app/attendance");
  await expect(page.getByTestId("attendance-overview")).toBeVisible();
  for (const id of ["ring-week", "ring-month", "ring-punctuality", "ring-hours"]) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId("ring-week")).toContainText("Hours this week");
  await expect(page.getByTestId("ring-week")).toContainText("of 40h");
  await expect(page.getByTestId("ring-month")).toContainText("Attendance, 30 days");
  await expect(page.getByTestId("ring-punctuality")).toContainText("Punctuality");
  await expect(page.getByTestId("ring-hours")).toContainText("Hours at work");
  for (const id of ["pipe-not-entered", "pipe-draft", "pipe-sent", "pipe-approved", "pipe-on-duty", "pipe-leave", "pipe-holiday"]) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId("pipe-not-entered")).toContainText("Not entered");
  await expect(page.getByTestId("pipe-not-entered")).toContainText("40.0h");
  // The tiles below the overview are still there.
  await expect(page.getByTestId("tile-clock")).toBeVisible();
});

test("Work timer: a running timer shows in the top bar and Stop adds its time to today", async ({ page }) => {
  await loginToApp(page, employeeToken);
  // A timer started 45 minutes ago, as the Start button would have saved it.
  const startedAt = new Date(Date.now() - 45 * 60_000).toISOString();
  await page.evaluate(([id, at]) => localStorage.setItem("aihxm.workTimer", JSON.stringify({ employeeId: id, startedAt: at, label: "Fiori app" })), [employeeId, startedAt]);
  await page.goto("/app/attendance/timesheet");
  await expect(page.getByTestId("timer-pill")).toBeVisible();
  await expect(page.getByTestId("timer-pill-time")).toContainText(/^0:4[5-9]:\d\d$/);
  await expect(page.getByTestId("timer-clock")).toContainText(/^0:4[5-9]:\d\d$/);
  await expect(page.getByTestId("timer-start")).toHaveCount(0);
  await page.getByTestId("timer-stop").click();
  await expect(page.getByTestId("timer-pill")).toHaveCount(0);
  await expect(page.getByTestId("timer-start")).toBeVisible();
  await expect(page.getByTestId(`ts-note-${todayIso()}`)).toContainText("Fiori app");
  await expect(page.getByTestId("ts-logged")).toContainText("0:4");
});

test("Timesheet: tiles, progress and the approval stepper follow what is typed and submitted", async ({ page }) => {
  await loginToApp(page, employeeToken);
  await page.goto("/app/attendance/timesheet");
  await expect(page.getByTestId("ts-tiles")).toBeVisible();
  await expect(page.getByTestId("ts-logged")).toContainText("0:4"); // the 45 minutes the timer just added
  await expect(page.getByTestId("ts-target")).toContainText("40:00");
  await expect(page.getByTestId("ts-status")).toHaveText("Draft");
  await expect(page.getByTestId("ts-approval")).toContainText("Draft");
  await expect(page.getByTestId("ts-approval")).toContainText("Manager");
  await expect(page.getByTestId("ts-approval")).toContainText("Approved");

  const today = todayIso();
  await page.locator(`#ts-${today}`).fill("8");
  await expect(page.getByTestId("ts-logged")).toContainText("8:00");
  await expect(page.getByTestId("ts-total")).toContainText("Total 8 h");
  await expect(page.getByTestId(`ts-day-${today}`)).toHaveClass(/is-today/);

  // Today jumps back after browsing to another week.
  const thisWeek = await page.getByTestId("ts-period").innerText();
  await page.getByRole("button", { name: "Previous week" }).click();
  await expect(page.getByTestId("ts-period")).not.toHaveText(thisWeek);
  await page.getByTestId("ts-today").click();
  await expect(page.getByTestId("ts-period")).toHaveText(thisWeek);

  await page.locator(`#ts-${today}`).fill("8");
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByTestId("ts-status")).toHaveText("Waiting for approval");
  await expect(page.getByTestId("ts-approval").locator("[aria-current=step]")).toContainText("Manager");
});

test("the employee sees the submitted week under My requests and in the home Action centre", async ({ page }) => {
  await loginToApp(page, employeeToken);
  await page.goto("/app/approvals");
  await expect(page.getByTestId("approvals-tab-mine")).toBeVisible();
  await expect(page.getByTestId("approvals-tab-all")).toHaveCount(0); // an employee decides nothing
  await expect(page.getByTestId("approvals-list")).toContainText("Week");
  await expect(page.getByTestId("approvals-list")).toContainText("Timesheet");

  await page.goto("/app");
  await expect(page.getByTestId("action-centre")).toBeVisible();
  await expect(page.getByTestId("kpi-hours-week")).toContainText("Hours this week");
  await expect(page.getByTestId("kpi-in-progress")).toContainText("Requests in progress");
  await expect(page.getByTestId("requests-in-progress")).toContainText("Timesheet");
});

test("HR approves the week from Approvals and it leaves the list", async ({ page }) => {
  await loginToApp(page, hrToken);
  await page.goto("/app/approvals");
  await expect(page.getByTestId("approvals-tab-all")).toBeVisible();
  const approve = page.locator("[data-testid^='approve-timesheet:']").first();
  await expect(approve).toBeVisible();
  await approve.click();
  await expect(page.locator("[data-testid^='approve-timesheet:']")).toHaveCount(0);
});

test("the employee then sees the week as Approved", async ({ page }) => {
  await loginToApp(page, employeeToken);
  await page.goto("/app/attendance/timesheet");
  await expect(page.getByTestId("ts-status")).toHaveText("Approved");
  await expect(page.getByTestId("ts-approval").locator("[aria-current=step]")).toHaveCount(0);
});

test("a timer cannot add time to an approved week: it says so and keeps running until discarded", async ({ page }) => {
  await loginToApp(page, employeeToken);
  const startedAt = new Date(Date.now() - 20 * 60_000).toISOString();
  await page.evaluate(([id, at]) => localStorage.setItem("aihxm.workTimer", JSON.stringify({ employeeId: id, startedAt: at, label: "Late work" })), [employeeId, startedAt]);
  await page.goto("/app/attendance/timesheet");
  await page.getByTestId("timer-stop").click();
  await expect(page.getByText(/already approved, so 20 min could not be added/)).toBeVisible();
  await expect(page.getByTestId("timer-pill")).toBeVisible();
  await page.getByTestId("timer-discard").click();
  await expect(page.getByTestId("timer-pill")).toHaveCount(0);
});
