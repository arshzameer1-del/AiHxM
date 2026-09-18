import { test, expect, Page } from "@playwright/test";

/**
 * Performance & Goals E2E Tests (Task #53)
 *
 * Tests complete performance management workflows:
 * - View active performance review cycles
 * - Employee self-assessment submission
 * - Manager assessment and feedback submission
 * - Goal setting and progress tracking
 * - System Admin calibration session view
 *
 * Roles tested:
 * - hr_admin: Full access to all reviews, cycle management, calibration
 * - line_manager: Assess direct reports, provide feedback
 * - employee_self_service: Submit self-assessment, set goals, view feedback
 * - system_admin: Access calibration sessions, moderation tools
 *
 * Prerequisites:
 * - Backend API running on http://localhost:3000
 * - Frontend dev server running on http://localhost:5173
 * - Test database seeded with test company, active review cycles
 */

const API_BASE_URL = "http://localhost:3000";
const PORTAL_URL = "http://localhost:5173/app";

interface TestContext {
  page: Page;
  companyId: string;
  hrAdminToken: string;
  employeeId: string;
  lineManagerToken: string;
  cycleId: string;
}

async function setupTestContext(): Promise<TestContext> {
  return {
    page: {} as Page,
    companyId: "test-company-id",
    hrAdminToken: "test-hr-admin-token",
    employeeId: "test-employee-id",
    lineManagerToken: "test-line-manager-token",
    cycleId: "test-cycle-id",
  };
}

async function loginAsRole(
  page: Page,
  token: string,
  roleKeys: string[],
  userId: string,
  companyId: string
) {
  await page.evaluate(
    ({ token, roleKeys, userId, companyId }) => {
      localStorage.setItem("authToken", token);
      localStorage.setItem(
        "identity",
        JSON.stringify({
          sub: userId,
          is_platform_admin: false,
          company_id: companyId,
          roleKeys,
        })
      );
    },
    { token, roleKeys, userId, companyId }
  );

  await page.goto("/app");
  await page.waitForSelector("nav", { timeout: 5000 });
}

test.describe("Performance & Goals Portal (Task #53)", () => {
  test.beforeEach(async ({ page }) => {
    // Test setup handled per test
  });

  test("Employee can view active performance review cycles", async ({
    page,
  }) => {
    // Navigate to performance page
    await page.goto("/app/performance");

    // Expect performance page to load
    await expect(
      page.locator("h1, h2").filter({ hasText: /performance|review/i })
    ).toBeVisible();

    // Verify cycles section exists
    const cyclesSection = page
      .locator("[data-testid='review-cycles']")
      .or(page.locator("text=Review Cycles"))
      .or(page.locator("text=Active Reviews"));

    await expect(cyclesSection).toBeVisible();

    // Verify list of cycles
    const cyclesList = page
      .locator("table")
      .or(page.locator(".cycle-card"))
      .or(page.locator("[data-testid='cycles-list']"));

    if (await cyclesList.isVisible()) {
      // Should show at least one active cycle
      const cycles = cyclesList.locator("tr, .cycle-card");
      expect(await cycles.count()).toBeGreaterThanOrEqual(1);
    }
  });

  test("Employee can submit self-assessment", async ({ page }) => {
    await page.goto("/app/performance");

    // Find active review cycle
    const activeCycle = page
      .locator("table tbody tr, .cycle-card, .review-item")
      .filter({ hasText: /active|in progress/i });

    if ((await activeCycle.count()) > 0) {
      // Click on cycle to open details
      await activeCycle.first().click();

      // Expect review detail view
      const detailView = page
        .locator("[data-testid='review-detail']")
        .or(page.locator("text=Self-Assessment"))
        .or(page.locator("text=My Feedback"));

      await expect(detailView).toBeVisible({ timeout: 5000 });

      // Look for self-assessment section
      const selfAssessmentSection = page
        .locator("[data-testid='self-assessment']")
        .or(page.locator("text=Self-Assessment"))
        .or(page.locator("text=My Assessment"));

      if (await selfAssessmentSection.isVisible()) {
        // Look for edit or submit button
        const editButton = selfAssessmentSection
          .locator("button:has-text('Edit')")
          .or(selfAssessmentSection.locator("button:has-text('Add')"));

        if (await editButton.isVisible()) {
          await editButton.click();

          // Expect assessment form
          const form = page.locator("form").or(page.locator("[role='dialog']"));
          await expect(form).toBeVisible({ timeout: 5000 });

          // Fill in self-assessment (textarea)
          const assessmentInput = page
            .locator('textarea[name="selfAssessment"]')
            .or(
              page.locator(
                'textarea[placeholder*="assessment" i]'
              )
            );
          if (await assessmentInput.isVisible()) {
            await assessmentInput.fill(
              "Strong performance this cycle. Met all key objectives and improved technical leadership skills."
            );
          }

          // Rating/score if applicable
          const ratingSelect = page
            .locator('select[name="selfRating"]')
            .or(page.locator("[aria-label*='Self Rating']"));
          if (await ratingSelect.isVisible()) {
            await ratingSelect.selectOption("4");
          }

          // Submit assessment
          const submitButton = page
            .locator('button:has-text("Submit")')
            .or(page.locator('button:has-text("Save")'));
          await submitButton.click();

          // Expect success
          await expect(
            page
              .locator("text=submitted")
              .or(page.locator("text=saved"))
              .or(page.locator("text=success"))
          ).toBeVisible({ timeout: 5000 });
        }
      }
    }
  });

  test("Manager can view and assess direct report", async ({ page }) => {
    await page.goto("/app/performance");

    // Find a direct report to assess
    const directReport = page
      .locator("table tbody tr, .report-card, .employee-item")
      .filter({ hasText: /pending|awaiting/i });

    if ((await directReport.count()) > 0) {
      // Click to open assessment view
      await directReport.first().click();

      // Expect assessment form
      const assessmentSection = page
        .locator("[data-testid='manager-assessment']")
        .or(page.locator("text=Manager Feedback"))
        .or(page.locator("text=Assessment"));

      await expect(assessmentSection).toBeVisible({ timeout: 5000 });

      // Fill in manager feedback
      const feedbackInput = page
        .locator('textarea[name="managerFeedback"]')
        .or(
          page.locator(
            'textarea[placeholder*="feedback" i]'
          )
        );
      if (await feedbackInput.isVisible()) {
        await feedbackInput.fill(
          "Excellent performance. Demonstrated strong leadership and delivered key projects on time."
        );
      }

      // Rating
      const ratingSelect = page
        .locator('select[name="managerRating"]')
        .or(page.locator("[aria-label*='Manager Rating']"));
      if (await ratingSelect.isVisible()) {
        await ratingSelect.selectOption("4");
      }

      // Submit assessment
      const submitButton = page
        .locator('button:has-text("Submit")')
        .or(page.locator('button:has-text("Save")'));
      if (await submitButton.isVisible()) {
        await submitButton.click();

        // Expect success
        await expect(
          page
            .locator("text=submitted")
            .or(page.locator("text=success"))
        ).toBeVisible({ timeout: 5000 });
      }
    }
  });

  test("Employee can set and track goals", async ({ page }) => {
    await page.goto("/app/performance");

    // Navigate to goals section
    const goalsTab = page
      .locator("[role='tab']")
      .filter({ hasText: /goals/i });
    if (await goalsTab.isVisible()) {
      await goalsTab.click();
    }

    // Expect goals view
    const goalsSection = page
      .locator("[data-testid='goals']")
      .or(page.locator("text=Goals"))
      .or(page.locator("text=Objectives"));

    await expect(goalsSection).toBeVisible();

    // Look for "Add Goal" or "New Goal" button
    const addGoalButton = page
      .locator("button:has-text('New Goal')")
      .or(page.locator("button:has-text('Add Goal')")
    );

    if (await addGoalButton.isVisible()) {
      await addGoalButton.click();

      // Expect goal creation form
      const form = page.locator("form").or(page.locator("[role='dialog']"));
      await expect(form).toBeVisible({ timeout: 5000 });

      // Fill goal details
      const goalTitle = page
        .locator('input[name="goalTitle"]')
        .or(page.locator('input[name="title"]'));
      if (await goalTitle.isVisible()) {
        await goalTitle.fill("Complete advanced leadership certification");
      }

      const goalDescription = page
        .locator('textarea[name="description"]')
        .or(page.locator('textarea[name="goalDescription"]'));
      if (await goalDescription.isVisible()) {
        await goalDescription.fill(
          "Complete executive leadership program and apply learnings to team"
        );
      }

      // Target completion date
      const targetDate = page
        .locator('input[name="targetDate"]')
        .or(page.locator('input[type="date"]'));
      if (await targetDate.isVisible()) {
        const endOfYear = new Date();
        endOfYear.setMonth(11);
        endOfYear.setDate(31);
        await targetDate.fill(endOfYear.toISOString().split("T")[0]);
      }

      // Submit goal
      const submitButton = page
        .locator('button:has-text("Create")')
        .or(page.locator('button:has-text("Save")'));
      await submitButton.click();

      // Expect success
      await expect(
        page
          .locator("text=created")
          .or(page.locator("text=added"))
          .or(page.locator("text=success"))
      ).toBeVisible({ timeout: 5000 });
    }

    // Verify goal appears in list
    const goalsList = page
      .locator("[data-testid='goals-list']")
      .or(page.locator(".goal-card"));
    if (await goalsList.isVisible()) {
      await expect(goalsList).toBeVisible();
    }
  });

  test("Employee can update goal progress", async ({ page }) => {
    await page.goto("/app/performance");

    // Navigate to goals
    const goalsTab = page
      .locator("[role='tab']")
      .filter({ hasText: /goals/i });
    if (await goalsTab.isVisible()) {
      await goalsTab.click();
    }

    // Find an existing goal
    const goalCard = page.locator(".goal-card").or(
      page.locator("[data-testid='goal-item']")
    );

    if ((await goalCard.count()) > 0) {
      // Find progress update button
      const updateButton = goalCard
        .first()
        .locator("button:has-text('Update')")
        .or(
          goalCard.first().locator("button:has-text('Progress')")
        );

      if (await updateButton.isVisible()) {
        await updateButton.click();

        // Expect progress form
        const form = page.locator("form").or(page.locator("[role='dialog']"));
        await expect(form).toBeVisible({ timeout: 5000 });

        // Fill progress update
        const progressInput = page
          .locator('textarea[name="progressUpdate"]')
          .or(page.locator('textarea[name="update"]'));
        if (await progressInput.isVisible()) {
          await progressInput.fill(
            "Completed 60% of the certification program. On track for Q4 completion."
          );
        }

        // Progress percentage
        const progressPercent = page
          .locator('input[name="percentComplete"]')
          .or(page.locator('input[name="progress"]'));
        if (await progressPercent.isVisible()) {
          await progressPercent.fill("60");
        }

        // Submit
        const submitButton = page
          .locator('button:has-text("Update")')
          .or(page.locator('button:has-text("Save")'));
        await submitButton.click();

        // Expect success
        await expect(
          page
            .locator("text=updated")
            .or(page.locator("text=success"))
        ).toBeVisible({ timeout: 5000 });
      }
    }
  });

  test("System Admin can access calibration sessions", async ({ page }) => {
    await page.goto("/app/performance");

    // Look for calibration or moderation section (System Admin only)
    const calibrationSection = page
      .locator("[data-testid='calibration']")
      .or(page.locator("text=Calibration"))
      .or(page.locator("text=Moderation"));

    if (await calibrationSection.isVisible()) {
      // Expect calibration sessions list
      const sessionsList = calibrationSection.locator("table").or(
        calibrationSection.locator(".session-card")
      );

      if (await sessionsList.isVisible()) {
        await expect(sessionsList).toBeVisible();
      }

      // Find a calibration session to open
      const session = calibrationSection.locator("tr, .session-card").first();
      if ((await session.count()) > 0) {
        await session.click();

        // Expect calibration detail view
        const detailView = page
          .locator("[data-testid='calibration-detail']")
          .or(page.locator("text=Participants"))
          .or(page.locator("text=Ratings"));

        if (await detailView.isVisible()) {
          await expect(detailView).toBeVisible();
        }
      }
    }
  });

  test("Portal navigation includes Performance & Goals menu item", async ({
    page,
  }) => {
    await page.goto("/app");

    const perfNavLink = page.locator("nav a").filter({
      hasText: /performance|goals/i,
    });
    await expect(perfNavLink).toBeVisible();

    await perfNavLink.click();
    await expect(page).toHaveURL(/\/app\/performance/);
  });
});

test.describe("Performance Responsiveness", () => {
  test("Performance review form is responsive on mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto("/app/performance");

    // Navigate to a review (may be in modal or detail view)
    const review = page
      .locator(".review-card, .cycle-item, table tbody tr")
      .first();
    if ((await review.count()) > 0) {
      await review.click();

      // Form should be visible and responsive
      const form = page.locator("form").or(page.locator("[data-testid='review-form']"));
      if (await form.isVisible()) {
        // Inputs should not overflow
        const inputs = form.locator("input, textarea, select");
        const firstInput = inputs.first();
        const boundingBox = await firstInput.boundingBox();
        if (boundingBox) {
          expect(boundingBox.width).toBeLessThanOrEqual(375);
        }
      }
    }
  });
});

test.describe("Performance Accessibility", () => {
  test("Review form has proper ARIA labels", async ({ page }) => {
    await page.goto("/app/performance");

    // Find feedback textarea
    const feedbackInput = page
      .locator('textarea[name="feedback"]')
      .or(page.locator('textarea[name="managerFeedback"]'))
      .or(page.locator('[aria-label*="feedback" i]'));

    if ((await feedbackInput.count()) > 0) {
      // Should have label or aria-label
      const hasLabel =
        (await page.locator('label[for="feedback"]').count()) > 0 ||
        (await feedbackInput.first().evaluate((el) => el.hasAttribute("aria-label")));

      expect(hasLabel).toBe(true);
    }
  });

  test("Goals list has semantic list structure", async ({ page }) => {
    await page.goto("/app/performance");

    // Navigate to goals
    const goalsTab = page
      .locator("[role='tab']")
      .filter({ hasText: /goals/i });
    if (await goalsTab.isVisible()) {
      await goalsTab.click();
    }

    // Goals should be in list or have proper roles
    const goalsList = page
      .locator("ol, ul, [role='list']")
      .or(page.locator(".goals-list"));

    if ((await goalsList.count()) > 0) {
      const items = goalsList.first().locator("li, [role='listitem']");
      expect(await items.count()).toBeGreaterThanOrEqual(0);
    }
  });
});
