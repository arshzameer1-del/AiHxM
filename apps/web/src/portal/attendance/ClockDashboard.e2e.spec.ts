import { expect, test } from "@playwright/test";
import { API_BASE_URL, createHrAdminSession, createRoleSession, loginToApp } from "../../e2e-support/real-session";

/** Home tile with the shift time and a link to detail; Clock In / Out with shift, live time, punches and the attendance card. Real API. */
test.describe.configure({ mode: "serial" });
let employeeToken = "";

async function call(method: string, path: string, token: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API_BASE_URL}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

test.beforeAll(async () => {
  const hr = await createHrAdminSession();
  employeeToken = await createRoleSession(hr, "employee_self_service");
  const me = await call("GET", "/auth/me", employeeToken);
  const shift = await call("POST", "/shifts", hr.token, { name: "General shift", startTime: "09:00", endTime: "18:00", graceMinutesLate: 15, isDefault: true });
  await call("POST", "/shift-assignments", hr.token, { employeeId: me.employeeId, shiftId: shift.id, effectiveFrom: "2020-01-01" });
});

test("Home shows today's shift time on the attendance tile and the tile opens Clock In / Out", async ({ page }) => {
  await loginToApp(page, employeeToken);
  const tile = page.getByTestId("kpi-attendance");
  await expect(tile).toContainText("Not clocked in");
  await expect(page.getByTestId("kpi-attendance-shift")).toContainText("General shift");
  await expect(page.getByTestId("kpi-attendance-shift")).toContainText("9:00 AM – 6:00 PM");
  await expect(page.getByTestId("my-attendance-card")).toBeVisible();
  await expect(page.getByTestId("my-timesheet-card")).toBeVisible();
  await tile.click();
  await expect(page).toHaveURL(/\/app\/attendance\/clock/);
  await expect(page.getByTestId("shift-hours")).toHaveText("9:00 AM – 6:00 PM");
});

test("Clock in shows running time and the punch; clock out fills check-out and worked; Home reflects it", async ({ page }) => {
  await loginToApp(page, employeeToken);
  await page.goto("/app/attendance/clock");
  await page.getByRole("button", { name: "Clock in", exact: true }).click();
  await expect(page.getByTestId("running-time")).toBeVisible();
  await expect(page.getByTestId("today-punches").locator("li")).toHaveCount(1);
  await expect(page.getByTestId("today-summary")).toContainText("Working…");

  await page.getByRole("button", { name: "Clock out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Clock in", exact: true })).toBeVisible();
  await expect(page.getByTestId("running-time")).toHaveCount(0);
  await expect(page.getByTestId("today-summary")).not.toContainText("Working…");
  await expect(page.getByTestId("today-summary")).toContainText(/\d{1,2}:\d{2} (AM|PM)/);

  // Home: the tile now reflects the day (a punch was made), and the strip's today cell is coloured.
  await page.goto("/app");
  await expect(page.getByTestId("kpi-attendance")).not.toContainText("Not clocked in");
  await expect(page.getByTestId("kpi-attendance")).toContainText("General shift");
});
