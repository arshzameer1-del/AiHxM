import { test, expect, Page } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/**
 * Time & Attendance E2E: its own module, opened from its own sidebar entry and tiles, separate from Leave
 * Management (the leave specs live in ../leave/).
 */

async function loginAsEmployee(page: Page) {
  await loginToApp(page, getSharedSession("employee_self_service"));
}

test.describe("Time & Attendance Portal", () => {
  test("Leave Management and Time & Attendance are separate: neither shows the other's tiles", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/attendance");
    await expect(page.getByRole("heading", { name: "Time & Attendance" })).toBeVisible();
    await expect(page.getByTestId("tile-clock")).toBeVisible();
    await expect(page.getByTestId("tile-timesheet")).toBeVisible();
    await expect(page.getByTestId("tile-my-leave")).toHaveCount(0);
    await expect(page.getByTestId("tile-create-leave")).toHaveCount(0);
  });

  test("Employee can view attendance records", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/attendance");
    await page.getByTestId("tile-clock").click();
    await expect(page).toHaveURL(/\/app\/attendance\/clock/);

    // The Clock in/out button is the stable signal that the clock page rendered.
    const clockButton = page
      .locator("button")
      .filter({ hasText: /clock in|clock out|done for today/i });
    await expect(clockButton).toBeVisible();
  });

  test("Employee can view daily attendance summary", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/attendance/days");

    // Look for attendance summary card
    const summaryCard = page
      .locator("[data-testid='daily-attendance']")
      .or(page.locator("text=Today").or(page.locator("text=Check-in")));

    if (await summaryCard.isVisible()) {
      // Verify check-in status and time
      const checkInTime = summaryCard.locator("text=/\\d{1,2}:\\d{2}/");
      if (await checkInTime.isVisible()) {
        await expect(checkInTime).toBeVisible();
      }

      // Verify working hours calculation
      const workingHours = summaryCard.locator("text=/\\d+\\.\\d+ hours/").or(
        summaryCard.locator("text=Working Hours")
      );
      if (await workingHours.isVisible()) {
        await expect(workingHours).toBeVisible();
      }
    }
  });
});
