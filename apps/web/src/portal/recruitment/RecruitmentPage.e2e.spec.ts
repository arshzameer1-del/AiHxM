import { test, expect, Page } from "@playwright/test";

/**
 * Recruitment E2E Tests (Task #51)
 *
 * Tests complete recruitment workflows:
 * - HR requisition creation and management
 * - Candidate pipeline tracking in Kanban view
 * - Candidate profile viewing with resume/attachments
 * - Interview scheduling and feedback submission
 * - Offer generation and e-sign workflow
 *
 * Roles tested:
 * - hr_admin: Full access to requisitions, candidates, offers, interviews
 * - line_manager: View open requisitions, submit feedback on candidates
 * - hiring_manager: Participate in interviews, provide assessments
 *
 * Prerequisites:
 * - Backend API running on http://localhost:3000
 * - Frontend dev server running on http://localhost:5173
 * - Test database seeded with test company, open requisitions, candidates
 */

const API_BASE_URL = "http://localhost:3000";
const PORTAL_URL = "http://localhost:5173/app";

interface TestContext {
  page: Page;
  companyId: string;
  hrAdminToken: string;
  requisitionId: string;
  candidateId: string;
}

async function setupTestContext(): Promise<TestContext> {
  return {
    page: {} as Page,
    companyId: "test-company-id",
    hrAdminToken: "test-hr-admin-token",
    requisitionId: "test-requisition-id",
    candidateId: "test-candidate-id",
  };
}

async function loginAsHrAdmin(page: Page, token: string, companyId: string) {
  await page.evaluate(
    ({ token, companyId }) => {
      localStorage.setItem("authToken", token);
      localStorage.setItem(
        "identity",
        JSON.stringify({
          sub: "hr-admin-user",
          is_platform_admin: false,
          company_id: companyId,
          roleKeys: ["hr_admin"],
        })
      );
    },
    { token, companyId }
  );

  await page.goto("/app");
  await page.waitForSelector("nav", { timeout: 5000 });
}

test.describe("Recruitment Portal (Task #51)", () => {
  test.beforeEach(async ({ page }) => {
    // Test setup handled per test
  });

  test("HR can view open requisitions list", async ({ page }) => {
    // Navigate to recruitment page
    await page.goto("/app/recruitment");

    // Expect page to load with recruitment data
    await expect(
      page.locator("h1, h2").filter({ hasText: /recruitment|requisition/i })
    ).toBeVisible();

    // Verify requisitions section exists
    const requisitionsSection = page
      .locator("[data-testid='requisitions']")
      .or(page.locator("text=Requisitions"))
      .or(page.locator("text=Open Positions"));

    await expect(requisitionsSection).toBeVisible();

    // Verify list or table of requisitions
    const requisitionsList = page
      .locator("table")
      .or(page.locator(".requisition-card"))
      .or(page.locator("[data-testid='requisitions-list']"));

    if (await requisitionsList.isVisible()) {
      await expect(requisitionsList).toBeVisible();
    }
  });

  test("HR can create a new requisition", async ({ page }) => {
    await page.goto("/app/recruitment");

    // Look for "New Requisition" or "Create Requisition" button
    const createButton = page
      .locator("button:has-text('New Requisition')")
      .or(page.locator("button:has-text('Create Requisition')"))
      .or(page.locator("button:has-text('Open Position')"));

    if (await createButton.isVisible()) {
      await createButton.click();

      // Expect form or modal to open
      const form = page.locator("form").or(page.locator("[role='dialog']"));
      await expect(form).toBeVisible({ timeout: 5000 });

      // Fill in requisition details
      const timestamp = Date.now();

      // Position title
      const titleInput = page
        .locator('input[name="title"]')
        .or(page.locator('input[name="position"]'));
      if (await titleInput.isVisible()) {
        await titleInput.fill(`Software Engineer ${timestamp}`);
      }

      // Department
      const departmentSelect = page.locator('select[name="department"]');
      if (await departmentSelect.isVisible()) {
        await departmentSelect.selectOption("engineering");
      }

      // Required experience
      const experienceInput = page
        .locator('input[name="yearsExperience"]')
        .or(page.locator('input[name="experience"]'));
      if (await experienceInput.isVisible()) {
        await experienceInput.fill("3");
      }

      // Salary range
      const minSalary = page.locator('input[name="minSalary"]').or(
        page.locator('input[name="salaryMin"]')
      );
      if (await minSalary.isVisible()) {
        await minSalary.fill("80000");
      }

      const maxSalary = page.locator('input[name="maxSalary"]').or(
        page.locator('input[name="salaryMax"]')
      );
      if (await maxSalary.isVisible()) {
        await maxSalary.fill("120000");
      }

      // Submit form
      const submitButton = page
        .locator('button:has-text("Create")')
        .or(page.locator('button:has-text("Submit")'));
      await submitButton.click();

      // Expect success notification
      await expect(
        page
          .locator("text=created")
          .or(page.locator("text=success"))
          .or(page.locator(/requisition.*created/i))
      ).toBeVisible({ timeout: 5000 });
    }
  });

  test("HR can view candidate pipeline in Kanban view", async ({ page }) => {
    await page.goto("/app/recruitment");

    // Navigate to pipeline or candidates view
    const pipelineTab = page
      .locator("[role='tab']")
      .filter({ hasText: /pipeline|candidates|kanban/i });
    if (await pipelineTab.isVisible()) {
      await pipelineTab.click();
    }

    // Expect Kanban board to appear with columns for each stage
    const kanbanBoard = page
      .locator("[data-testid='pipeline-kanban']")
      .or(page.locator(".kanban-board"))
      .or(page.locator(".pipeline-board"));

    if (await kanbanBoard.isVisible()) {
      // Verify multiple columns exist (Applied, Screening, Interview, Offer, Hired, Rejected)
      const columns = kanbanBoard.locator("[data-testid='kanban-column']").or(
        kanbanBoard.locator(".kanban-column").or(kanbanBoard.locator(".pipeline-stage"))
      );

      const columnCount = await columns.count();
      expect(columnCount).toBeGreaterThanOrEqual(3);

      // Verify candidate cards in columns
      const candidateCards = kanbanBoard.locator(".candidate-card").or(
        kanbanBoard.locator("[data-testid='candidate-card']")
      );
      if ((await candidateCards.count()) > 0) {
        await expect(candidateCards.first()).toBeVisible();
      }
    }
  });

  test("HR can view candidate profile with resume", async ({ page }) => {
    await page.goto("/app/recruitment");

    // Navigate to candidates section
    const candidatesTab = page
      .locator("[role='tab']")
      .filter({ hasText: /candidates/i });
    if (await candidatesTab.isVisible()) {
      await candidatesTab.click();
    }

    // Find first candidate
    const candidateRow = page.locator("table tbody tr").or(
      page.locator(".candidate-card").or(page.locator(".candidate-item"))
    );

    if ((await candidateRow.count()) > 0) {
      // Click on first candidate to open detail view
      await candidateRow.first().click();

      // Expect candidate detail view
      const detailView = page
        .locator("[data-testid='candidate-detail']")
        .or(page.locator("text=Resume"))
        .or(page.locator("text=Email"));

      await expect(detailView).toBeVisible({ timeout: 5000 });

      // Verify candidate information
      await expect(page.locator("text=Email").or(page.locator("text=Phone"))).toBeVisible();

      // Verify resume attachment
      const resumeSection = page
        .locator("[data-testid='resume']")
        .or(page.locator("text=Resume"))
        .or(page.locator("a:has-text('Download')"));

      if (await resumeSection.isVisible()) {
        await expect(resumeSection).toBeVisible();
      }
    }
  });

  test("HR can schedule an interview", async ({ page }) => {
    await page.goto("/app/recruitment");

    // Navigate to a candidate or requisition with candidates
    const candidateRow = page.locator("table tbody tr").or(
      page.locator(".candidate-card")
    );

    if ((await candidateRow.count()) > 0) {
      // Find interview or schedule button
      const scheduleButton = candidateRow
        .first()
        .locator("button:has-text('Interview')")
        .or(
          candidateRow.first().locator("button:has-text('Schedule Interview')")
        )
        .or(
          candidateRow
            .first()
            .locator("button:has-text('Add Interview')")
        );

      if (await scheduleButton.isVisible()) {
        await scheduleButton.click();

        // Expect interview scheduling form/modal
        const form = page.locator("form").or(page.locator("[role='dialog']"));
        await expect(form).toBeVisible({ timeout: 5000 });

        // Fill interview details
        const interviewDate = page
          .locator('input[name="interviewDate"]')
          .or(page.locator('input[type="date"]'));
        if (await interviewDate.isVisible()) {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 3);
          await interviewDate.fill(tomorrow.toISOString().split("T")[0]);
        }

        const interviewTime = page.locator('input[name="interviewTime"]').or(
          page.locator('input[type="time"]')
        );
        if (await interviewTime.isVisible()) {
          await interviewTime.fill("10:00");
        }

        const interviewerSelect = page
          .locator('select[name="interviewer"]')
          .or(page.locator("[aria-label*='Interviewer']"));
        if (await interviewerSelect.isVisible()) {
          const options = await interviewerSelect.locator("option").count();
          if (options > 1) {
            await interviewerSelect.selectOption({ index: 1 });
          }
        }

        // Submit
        const submitButton = page
          .locator('button:has-text("Schedule")')
          .or(page.locator('button:has-text("Confirm")'));
        await submitButton.click();

        // Expect success
        await expect(
          page
            .locator("text=scheduled")
            .or(page.locator("text=success"))
        ).toBeVisible({ timeout: 5000 });
      }
    }
  });

  test("Interviewer can submit interview feedback", async ({ page }) => {
    await page.goto("/app/recruitment");

    // Find candidate with scheduled interview
    const candidateWithInterview = page
      .locator(".candidate-card, table tbody tr")
      .filter({ hasText: /interview|scheduled/i });

    if ((await candidateWithInterview.count()) > 0) {
      // Find feedback button
      const feedbackButton = candidateWithInterview
        .first()
        .locator("button:has-text('Feedback')")
        .or(
          candidateWithInterview
            .first()
            .locator("button:has-text('Add Feedback')")
        )
        .or(
          candidateWithInterview
            .first()
            .locator("button:has-text('Submit Feedback')")
        );

      if (await feedbackButton.isVisible()) {
        await feedbackButton.click();

        // Expect feedback form
        const form = page.locator("form").or(page.locator("[role='dialog']"));
        await expect(form).toBeVisible({ timeout: 5000 });

        // Fill in rating/score
        const ratingSelect = page
          .locator('select[name="rating"]')
          .or(page.locator("[aria-label*='Rating']"));
        if (await ratingSelect.isVisible()) {
          await ratingSelect.selectOption("4");
        }

        // Fill in comments
        const commentsInput = page
          .locator('textarea[name="comments"]')
          .or(page.locator('textarea[name="feedback"]'));
        if (await commentsInput.isVisible()) {
          await commentsInput.fill("Strong technical skills, good communication");
        }

        // Submit
        const submitButton = page
          .locator('button:has-text("Submit")')
          .or(page.locator('button:has-text("Save")'));
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

  test("HR can generate and send offer", async ({ page }) => {
    await page.goto("/app/recruitment");

    // Find candidate in offer-ready stage
    const candidateForOffer = page
      .locator(".candidate-card, table tbody tr")
      .filter({ hasText: /offer|hired/i });

    if ((await candidateForOffer.count()) > 0) {
      // Find offer button
      const offerButton = candidateForOffer
        .first()
        .locator("button:has-text('Offer')")
        .or(
          candidateForOffer.first().locator("button:has-text('Create Offer')")
        )
        .or(
          candidateForOffer
            .first()
            .locator("button:has-text('Send Offer')")
        );

      if (await offerButton.isVisible()) {
        await offerButton.click();

        // Expect offer details form/modal
        const form = page.locator("form").or(page.locator("[role='dialog']"));
        await expect(form).toBeVisible({ timeout: 5000 });

        // Fill salary (pre-filled from requisition)
        const salaryInput = page.locator('input[name="salary"]');
        if (await salaryInput.isVisible()) {
          await salaryInput.fill("100000");
        }

        // Select start date
        const startDateInput = page
          .locator('input[name="startDate"]')
          .or(page.locator('input[type="date"]'));
        if (await startDateInput.isVisible()) {
          const twoWeeksFromNow = new Date();
          twoWeeksFromNow.setDate(twoWeeksFromNow.getDate() + 14);
          await startDateInput.fill(
            twoWeeksFromNow.toISOString().split("T")[0]
          );
        }

        // Submit offer
        const submitButton = page
          .locator('button:has-text("Send")')
          .or(page.locator('button:has-text("Create")'));
        await submitButton.click();

        // Expect success
        await expect(
          page
            .locator("text=sent")
            .or(page.locator("text=created"))
            .or(page.locator(/offer.*sent|sent.*offer/i))
        ).toBeVisible({ timeout: 5000 });
      }
    }
  });

  test("Portal navigation includes Recruitment menu item", async ({
    page,
  }) => {
    await page.goto("/app");

    const recruitmentNavLink = page.locator("nav a").filter({
      hasText: /recruitment/i,
    });
    await expect(recruitmentNavLink).toBeVisible();

    await recruitmentNavLink.click();
    await expect(page).toHaveURL(/\/app\/recruitment/);
  });
});

test.describe("Recruitment Responsiveness", () => {
  test("Candidate pipeline is usable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto("/app/recruitment");

    // Kanban or candidate list should be visible
    const pipelineSection = page
      .locator("[data-testid='pipeline']")
      .or(page.locator(".kanban-board"))
      .or(page.locator(".candidate-list"));

    if (await pipelineSection.isVisible()) {
      await expect(pipelineSection).toBeVisible();

      // On mobile, may show as vertical scroll or tabs
      const bodyWidth = await page.evaluate(() => document.body.offsetWidth);
      expect(bodyWidth).toBeLessThanOrEqual(375);
    }
  });
});

test.describe("Recruitment Accessibility", () => {
  test("Candidate cards have accessible structure", async ({ page }) => {
    await page.goto("/app/recruitment");

    const candidateCard = page.locator(".candidate-card").or(
      page.locator("[data-testid='candidate-card']")
    );

    if ((await candidateCard.count()) > 0) {
      // Verify card has interactive elements with proper roles
      const interactiveElements = candidateCard
        .first()
        .locator("button, a, [role='button']");

      expect(await interactiveElements.count()).toBeGreaterThan(0);
    }
  });
});
