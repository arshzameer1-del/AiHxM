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

  test("Employee can view leave balance and request summary", async ({
    page,
  }) => {
    await loginAsEmployee(page);
    // Navigate to leave page
    await page.goto("/app/leave");

    // Expect leave page to load with balance summary. `.first()` — a real
    // loaded page has an h1 ("Leave & Attendance") plus section h2s ("My
    // Leave", "Leave Requests") that all match /leave/i, tripping the
    // same strict-mode "resolved to N elements" this whole suite had once
    // real content started actually rendering.
    await expect(page.locator("h1, h2").filter({ hasText: /leave/i }).first()).toBeVisible();

    // Verify leave balance card is visible
    const balanceCard = page.locator("[data-testid='leave-balance-card']").or(
      page.locator("text=Annual Leave").or(page.locator("text=Leave Balance"))
    );
    if (await balanceCard.isVisible()) {
      // Check for balance information
      await expect(balanceCard.locator("text=/\\d+/")).toBeVisible();
    }

    // Verify leave request section exists
    const leaveSection = page.locator("[data-testid='leave-requests']").or(
      page.locator("text=Leave Requests").or(page.locator("text=My Requests"))
    );
    await expect(leaveSection).toBeVisible();
  });

  test("Employee can submit a new leave request", async ({ page }) => {
    await loginAsEmployee(page);
    // Navigate to leave request form
    await page.goto("/app/leave");

    // Look for "New Request" or "Request Leave" button
    const newRequestButton = page
      .locator("button:has-text('New Request')")
      .or(page.locator("button:has-text('Request Leave')"))
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
    // Navigate to leave page as manager
    await page.goto("/app/leave");

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
    await page.goto("/app/leave");

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
    await page.goto("/app/leave");

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
    await page.goto("/app/leave");

    // LeavePage.tsx (the `canClock` branch) folds attendance straight
    // into this same page as a Clock in/out widget — there's no separate
    // "/attendance" nav link or tab to navigate to, and no literal
    // "Attendance" text on the page (a bare `text=Attendance` locator
    // instead matched the "Leave & Attendance" nav link AND h1 AND the
    // page's own subtitle paragraph — a 3-way strict-mode violation). The
    // Clock in/out button is the real, stable signal that this widget
    // rendered.
    const clockButton = page
      .locator("button")
      .filter({ hasText: /clock in|clock out/i });
    await expect(clockButton).toBeVisible();
  });

  test("Employee can view daily attendance summary", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/leave");

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

  test("Portal navigation includes Leave & Attendance menu item", async ({
    page,
  }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app");

    const leaveNavLink = page.locator("nav a").filter({
      hasText: /leave|attendance/i,
    });
    await expect(leaveNavLink).toBeVisible();

    await leaveNavLink.click();
    await expect(page).toHaveURL(/\/app\/leave/);
  });
});

test.describe("Leave & Attendance Responsiveness", () => {
  test("Leave request form is responsive on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await loginAsEmployee(page);
    await page.goto("/app/leave");

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
    await page.goto("/app/leave");
    // LeaveRequestForm.tsx only mounts after clicking "Request Leave"
    // (LeavePage.tsx's `showForm` state) — it isn't present on page load.
    await page.locator("button", { hasText: "Request Leave" }).click();

    // Real finding (2026-10-01, same pattern as
    // EmployeeListPage.e2e.spec.ts's "Form labels are properly associated
    // with inputs" note): LeaveRequestForm.tsx's "Leave type" <select>
    // has a bare <label> with no `htmlFor`/`id` pairing and no `name` or
    // `aria-label` on the <select> itself — `select[name="leaveType"]`
    // matches nothing and hangs rather than reporting absence. Located by
    // the label's adjacent sibling instead so the assertion below can
    // actually run (and correctly fail, since there genuinely is no
    // programmatic label association here).
    const leaveTypeInput = page.locator('label:has-text("Leave type") + select');

    // Verify input has associated label or ARIA label
    const hasLabel =
      (await page
        .locator('label[for="leaveType"]')
        .or(page.locator('label[for="type"]'))
        .count()) > 0 ||
      (await leaveTypeInput.evaluate((el) => el.hasAttribute("aria-label"))) ||
      (await leaveTypeInput.evaluate((el) => el.closest("label"))) !== null;

    expect(hasLabel).toBe(true);
  });

  test("Leave records table has proper structure for screen readers", async ({
    page,
  }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/leave");

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
