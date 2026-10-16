import { expect, test } from "@playwright/test";
import { createHrAdminSession, createRoleSession, loginToApp } from "../../e2e-support/real-session";

/** Parked B1: a Line Manager gets a Team Attendance tile and page; an Employee does not. Against the real API. */
test.describe.configure({ mode: "serial" });

let managerToken = "";
let essToken = "";

test.beforeAll(async () => {
  const hr = await createHrAdminSession();
  managerToken = await createRoleSession(hr, "line_manager");
  essToken = await createRoleSession(hr, "employee_self_service");
});

test("a Line Manager opens Team Attendance from the tile; with no reports it says so", async ({ page }) => {
  await loginToApp(page, managerToken);
  await page.goto("/app/attendance");
  await page.getByTestId("tile-team-attendance").click();
  await expect(page).toHaveURL(/\/app\/attendance\/team$/);
  await expect(page.getByRole("heading", { name: "Team Attendance" })).toBeVisible();
  await expect(page.getByText("No one reports to you.")).toBeVisible();
});

test("an Employee has no Team Attendance tile", async ({ page }) => {
  await loginToApp(page, essToken);
  await page.goto("/app/attendance");
  await expect(page.getByTestId("tile-clock")).toBeVisible();
  await expect(page.getByTestId("tile-team-attendance")).toHaveCount(0);
});
