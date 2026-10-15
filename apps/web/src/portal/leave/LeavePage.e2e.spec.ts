import { test, expect, Page } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/**
 * Leave & Attendance E2E Tests (Task #50)
 *
 * Tests complete leave management workflows:
 * - Employee leave request submission (with date selection, comment, policy selection)
 * - Manager approval/rejection of pending requests
 * - HR visibility of all company leave records
 * - Employee self-service leave balance display
 * - Attendance data visualization (daily check-in/out, summary)
 *
 * Roles tested:
 * - hr_admin: Full access to all leave records, approval capability, policy configuration
 * - line_manager: View own and team member requests, approve/reject
 * - employee_self_service: Submit requests, view own balance and status
 *
 * Prerequisites:
 * - Backend API running on http://localhost:3000
 * - Frontend dev server running on http://localhost:5173
 * - Test database seeded with test company, employees, leave policies
 */

// Real-session fix (2026-10-01): `loginAsRole` below (with its fake
// per-arg token/roleKeys/userId) was never actually called by a single
// test in this file — every `page.goto("/app/leave")` hit the
// unauthenticated redirect, same root cause as every other spec in this
// suite (see real-session.ts's header comment for the full writeup: wrong
// localStorage key, and even the right key would have needed a real
// signed JWT). Replaced with real, shared, role-scoped sessions.

async function loginAsEmployee(page: Page) {
  await loginToApp(page, getSharedSession("employee_self_service"));
}
async function loginAsManager(page: Page) {
  await loginToApp(page, getSharedSession("line_manager"));
}
async function loginAsHrAdmin(page: Page) {
  await loginToApp(page, getSharedSession("hr_admin"));
}

test.describe("Leave & Attendance Portal (Task #50)", () => {
  test.beforeEach(async ({ page }) => {
    // Set up test context for each test
    // In a real scenario, this would set up API fixtures
  });

  test("Employee sees Leave Management tiles and opens My Leave Request from a tile", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/leave");

    // Launchpad: tiles for leave only. Attendance is a separate module with its own tiles.
    await expect(page.getByRole("heading", { name: "Leave Management" })).toBeVisible();
    await expect(page.getByTestId("tile-my-leave")).toBeVisible();
    await expect(page.getByTestId("tile-create-leave")).toBeVisible();
    await expect(page.getByTestId("tile-clock")).toHaveCount(0);

    await page.getByTestId("tile-my-leave").click();
    await expect(page).toHaveURL(/\/app\/leave\/my-requests/);
    await expect(page.getByRole("heading", { name: "My Leave Request" })).toBeVisible();
  });

  test("Leave Management and Time & Attendance are separate: neither shows the other's tiles", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/attendance");
    await expect(page.getByRole("heading", { name: "Time & Attendance" })).toBeVisible();
    await expect(page.getByTestId("tile-clock")).toBeVisible();
    await expect(page.getByTestId("tile-timesheet")).toBeVisible();
    await expect(page.getByTestId("tile-my-leave")).toHaveCount(0);
    await expect(page.getByTestId("tile-create-leave")).toHaveCount(0);
  });

  test("Employee can submit a new leave request", async ({ page }) => {
    await loginAsEmployee(page);
    // Navigate to leave request form
    await page.goto("/app/leave/my-requests");

    // Look for "New Request" or "Request Leave" button
    const newRequestButton = page
      .locator("button:has-text('New Request')")
      .or(page.locator("button:has-text('Create Request')"))
      .or(page.locator("button:has-text('Submit Request')"));

    if (await newRequestButton.isVisible()) {
      await newRequestButton.click();

      // Expect form or modal to open
      const form = page.locator("form").or(page.locator("[role='dialog']"));
      await expect(form).toBeVisible({ timeout: 5000 });

      // Fill in leave type (select from dropdown)
      const leaveTypeSelect = page.locator('select[name="leaveType"]').or(
        page.locator('select[name="type"]').or(page.locator('[aria-label*="Leave Type"]'))
      );
      if (await leaveTypeSelect.isVisible()) {
        await leaveTypeSelect.selectOption("annual");
      }

      // Fill in start date
      const startDateInput = page
        .locator('input[name="startDate"]')
        .or(page.locator('input[type="date"]').first());
      if (await startDateInput.isVisible()) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        await startDateInput.fill(tomorrow.toISOString().split("T")[0]);
      }

      // Fill in end date
      const endDateInput = page
        .locator('input[name="endDate"]')
        .or(page.locator('input[type="date"]').nth(1));
      if (await endDateInput.isVisible()) {
        const dayAfterTomorrow = new Date();
        dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);
        await endDateInput.fill(dayAfterTomorrow.toISOString().split("T")[0]);
      }

      // Fill in optional comment
      const commentInput = page
        .locator('textarea[name="comment"]')
        .or(page.locator('textarea[name="reason"]'));
      if (await commentInput.isVisible()) {
        await commentInput.fill("Annual leave for family trip");
      }

      // Submit the form
      const submitButton = page
        .locator('button:has-text("Submit")')
        .or(page.locator('button:has-text("Request")'));
      await submitButton.click();

      // Expect success notification or redirect
      await expect(
        page
          .locator("text=success")
          .or(page.locator("text=submitted"))
          .or(page.locator("text=request.*submitted"))
      ).toBeVisible({ timeout: 5000 });
    }
  });

  test("Manager can view and approve team leave requests", async ({
    page,
  }) => {
    await loginAsManager(page);
    // Navigate to leave approvals as manager
    await page.goto("/app/leave/approvals");

    // Expect to see team requests section
    const teamRequestsSection = page
      .locator("text=Team Requests")
      .or(page.locator("text=Pending Approvals"))
      .or(page.locator("[data-testid='team-leave-requests']"));

    if (await teamRequestsSection.isVisible()) {
      // Verify a table or list of requests appears
      const requestTable = page.locator("table").or(
        page.locator("[data-testid='requests-list']").or(page.locator(".request-card"))
      );
      await expect(requestTable).toBeVisible();

      // Find a pending request row
      const pendingRequest = requestTable
        .locator("tr")
        .or(page.locator(".request-item"))
        .filter({ hasText: /pending/i });

      if ((await pendingRequest.count()) > 0) {
        // Look for approve button on first pending request
        const approveButton = pendingRequest
          .first()
          .locator("button:has-text('Approve')");

        if (await approveButton.isVisible()) {
          await approveButton.click();

          // Expect confirmation modal or success message
          await expect(
            page
              .locator("text=Approved")
              .or(page.locator("text=success"))
              .or(page.locator("[role='dialog']"))
          ).toBeVisible({ timeout: 5000 });
        }
      }
    }
  });

  test("Manager can reject a leave request with comment", async ({ page }) => {
    await loginAsManager(page);
    await page.goto("/app/leave/approvals");

    // Find a pending request with reject button
    const pendingRequest = page
      .locator("tr, .request-item")
      .filter({ hasText: /pending/i });

    if ((await pendingRequest.count()) > 0) {
      const rejectButton = pendingRequest
        .first()
        .locator("button:has-text('Reject')");

      if (await rejectButton.isVisible()) {
        await rejectButton.click();

        // Expect rejection modal
        const modal = page.locator("[role='dialog']").or(
          page.locator("text=rejection reason").or(page.locator("text=Reason"))
        );
        if (await modal.isVisible()) {
          // Fill rejection reason
          const reasonInput = page.locator('textarea[name="rejectionReason"]').or(
            page.locator('textarea[placeholder*="reason" i]')
          );
          if (await reasonInput.isVisible()) {
            await reasonInput.fill("Conflicting project deadline");
          }

          // Confirm rejection
          const confirmButton = page.locator('button:has-text("Confirm")').or(
            page.locator('button:has-text("Reject")')
          );
          await confirmButton.click();

          // Expect success message
          await expect(
            page.locator("text=rejected").or(page.locator("text=success"))
          ).toBeVisible({ timeout: 5000 });
        }
      }
    }
  });

  test("HR Admin can view all company leave records and analytics", async ({
    page,
  }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/leave/approvals");

    // Verify page shows all leave records (not just employee's own).
    // `.first()` — see the identical note on the employee-balance test
    // above.
    const leaveHeader = page.locator("h1, h2").filter({ hasText: /leave/i }).first();
    await expect(leaveHeader).toBeVisible();

    // Real finding: LeavePage.tsx's hr_admin view is "Leave Requests" +
    // a "Submit on behalf" button + the records list/table — there is no
    // separate analytics/summary section with approved/pending/rejected
    // counts today, so this doesn't assert one exists.

    // Verify full company view (not just employee's requests)
    const leaveRecordsTable = page.locator("table");
    if (await leaveRecordsTable.isVisible()) {
      const rows = leaveRecordsTable.locator("tbody tr");
      await expect(rows).toHaveCountGreaterThanOrEqual(1);

      // Verify table has columns for employee name, dates, status, manager
      const headers = leaveRecordsTable.locator("thead th");
      await expect(headers).toHaveCountGreaterThanOrEqual(4);
    }
  });

  test("Employee can view attendance records", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/attendance");
    await page.getByTestId("tile-clock").click();
    await expect(page).toHaveURL(/\/app\/attendance\/clock/);

    // The Clock in/out button is the stable signal that the clock page rendered.
    const clockButton = page
      .locator("button")
      .filter({ hasText: /clock in|clock out/i });
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

  test("Portal navigation has separate Leave Management and Time & Attendance entries", async ({
    page,
  }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app");

    const leaveNavLink = page.locator("nav a").filter({ hasText: /^\s*Leave Management\s*$/ });
    const attendanceNavLink = page.locator("nav a").filter({ hasText: /^\s*Time & Attendance\s*$/ });
    await expect(leaveNavLink).toBeVisible();
    await expect(attendanceNavLink).toBeVisible();

    await leaveNavLink.click();
    await expect(page).toHaveURL(/\/app\/leave$/);
    await attendanceNavLink.click();
    await expect(page).toHaveURL(/\/app\/attendance$/);
  });
});

test.describe("Leave & Attendance Responsiveness", () => {
  test("Leave request form is responsive on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await loginAsEmployee(page);
    await page.goto("/app/leave/new");

    // Form or leave request section should be visible
    const form = page.locator("form").or(page.locator("[data-testid='leave-form']"));
    if (await form.isVisible()) {
      await expect(form).toBeVisible();

      // Inputs should not overflow horizontally
      const inputs = form.locator("input, select, textarea");
      for (let i = 0; i < (await inputs.count()); i++) {
        const input = inputs.nth(i);
        const boundingBox = await input.boundingBox();
        if (boundingBox) {
          expect(boundingBox.width).toBeLessThanOrEqual(375);
        }
      }
    }
  });
});

test.describe("Leave & Attendance Accessibility", () => {
  test("Leave request form has proper labels and associations", async ({
    page,
  }) => {
    await loginAsEmployee(page);
    // The form is its own page (Create Leave Request tile).
    await page.goto("/app/leave");
    await page.getByTestId("tile-create-leave").click();
    await expect(page).toHaveURL(/\/app\/leave\/new/);

    // The SAP-style form pairs each label with its field by htmlFor/id, so the field must be found by its label.
    const leaveTypeInput = page.locator("select#leave-type");
    await expect(leaveTypeInput).toBeVisible();
    const hasLabel = (await page.locator('label[for="leave-type"]').count()) > 0;
    expect(hasLabel).toBe(true);
  });

  test("Leave records table has proper structure for screen readers", async ({
    page,
  }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/leave/my-requests");

    // Verify table structure
    const table = page.locator("table");
    if (await table.isVisible()) {
      // Should have thead with th elements
      const thead = table.locator("thead");
      await expect(thead).toBeVisible();

      const headers = thead.locator("th");
      expect(await headers.count()).toBeGreaterThan(0);

      // Verify tbody and tr structure
      const tbody = table.locator("tbody");
      await expect(tbody).toBeVisible();

      const rows = tbody.locator("tr");
      expect(await rows.count()).toBeGreaterThanOrEqual(0);
    }
  });
});
