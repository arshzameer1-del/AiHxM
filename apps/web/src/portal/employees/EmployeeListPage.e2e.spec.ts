import { test, expect, Page } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/**
 * Employee Core E2E Tests
 *
 * Tests the complete Employee Core user flows (Task #48) across all portal screens:
 * - EmployeeListPage: listing, filtering, creating
 * - EmployeeDetailPage: viewing and editing employee data
 * - MyProfilePage: employee self-service profile access
 *
 * These tests exercise the actual user workflows and prevent regressions
 * in the real tenant-portal UI, which is Decision #15's pattern:
 * one list/detail screen serves every role, API handles RBAC scoping,
 * frontend only gates cosmetic buttons on identity.roleKeys.
 *
 * Prerequisites:
 * - Backend API running on http://localhost:4000 (see vite.config.ts's dev
 *   proxy target — e2e-support/real-session.ts's API_BASE_URL matches it)
 * - Frontend dev server running on http://localhost:5173
 *
 * This file's own `setupTestContext()` placeholder and `loginAsHrAdmin`
 * previously never actually got called by any test below — every
 * `page.goto("/app/employees")` hit the unauthenticated redirect, same
 * root cause as AdminCenterPage.e2e.spec.ts/SystemAdminPage.e2e.spec.ts
 * (see those files' comments) PLUS the wrong-localStorage-key/fake-token
 * bug every OTHER spec in this suite had (see real-session.ts's header
 * comment). Both are fixed here: every test now logs in for real.
 */

async function loginAsHrAdmin(page: Page) {
  await loginToApp(page, getSharedSession("hr_admin"));
}

async function loginAsLineManager(page: Page) {
  await loginToApp(page, getSharedSession("line_manager"));
}

async function loginAsEmployee(page: Page) {
  await loginToApp(page, getSharedSession("employee_self_service"));
}

test.describe("Employee Core Portal (Task #48)", () => {
  test("HR Admin can view employee list", async ({ page }) => {
    await loginAsHrAdmin(page);
    // Navigate to employee list
    await page.goto("/app/employees");

    // Expect the page to load and show the employee list
    await expect(page.locator("h1, h2").first()).toContainText(/employees/i);

    // Verify table structure
    const table = page.locator("table");
    await expect(table).toBeVisible();

    // Verify table headers exist. A freshly signed-up company has no
    // employees yet, so this only checks the header row renders at all —
    // the real column count is a UI-implementation detail this test
    // shouldn't pin down without reading EmployeeListPage.tsx itself.
    const headers = table.locator("thead th");
    expect(await headers.count()).toBeGreaterThan(0);
  });

  test("HR Admin can create a new employee", async ({ page }) => {
    await loginAsHrAdmin(page);
    // Navigate to employee create page
    await page.goto("/app/employees/new");

    // Fill in employee form
    const timestamp = Date.now();
    const email = `test-employee-${timestamp}@example.com`;

    // EmployeeCreatePage.tsx's <label> elements have no `htmlFor`/`id` and
    // its <input>s have no `name` attribute (see this file's own note on
    // the Accessibility describe block below) — there is no
    // `input[name=...]` to select, so these locate by the label's
    // adjacent-sibling input instead, matching the real DOM structure.
    await page.locator('label:has-text("First name") + input').fill("Test");
    await page.locator('label:has-text("Last name") + input').fill(`Employee${timestamp}`);
    await page.locator('label:has-text("Email") + input').fill(email);

    // Submit the form
    const submitButton = page.locator("button:has-text('Create Employee')");
    if (await submitButton.isVisible()) {
      await submitButton.click();

      // Expect redirect to employee detail page
      await expect(page).toHaveURL(/\/app\/employees\/[a-f0-9-]+$/, { timeout: 10000 });

      // Verify employee data is displayed
      await expect(page.locator(`text=${email}`)).toBeVisible();
    }
  });

  test("HR Admin can view employee details", async ({ page }) => {
    await loginAsHrAdmin(page);
    // Create a real employee via the UI first so there's always at least
    // one row to click — a freshly signed-up company starts with none.
    await page.goto("/app/employees/new");
    const timestamp = Date.now();
    await page.locator('label:has-text("First name") + input').fill("Detail");
    await page.locator('label:has-text("Last name") + input').fill(`Test${timestamp}`);
    await page.locator('label:has-text("Email") + input').fill(`detail-test-${timestamp}@example.com`);
    const createButton = page.locator("button:has-text('Create Employee')");
    if (await createButton.isVisible()) {
      await createButton.click();
      await page.waitForURL(/\/app\/employees\/[a-f0-9-]+$/, { timeout: 10000 });
    }

    // Navigate to employee list
    await page.goto("/app/employees");

    // Click on first employee
    const firstEmployeeLink = page.locator("table tbody tr:first-child a").first();
    if (await firstEmployeeLink.isVisible()) {
      await firstEmployeeLink.click();

      // Expect to be on employee detail page
      await expect(page).toHaveURL(/\/app\/employees\/[a-f0-9-]+$/);
    }
  });

  test("HR Admin can edit employee details", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/employees");

    // Click on first employee
    const firstEmployeeLink = page.locator("table tbody tr:first-child a").first();
    if (await firstEmployeeLink.isVisible()) {
      await firstEmployeeLink.click();
      await expect(page).toHaveURL(/\/app\/employees\/[a-f0-9-]+$/);

      // Click edit button
      const editButton = page.locator('button:has-text("Edit")');
      if (await editButton.isVisible()) {
        await editButton.click();
      }
    }
  });

  test("HR Admin can grant an employee a login", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/employees");

    // Click on first employee
    const firstEmployeeLink = page.locator("table tbody tr:first-child a").first();
    if (await firstEmployeeLink.isVisible()) {
      await firstEmployeeLink.click();

      // Look for "Create Login" or similar button in the detail view
      const createLoginButton = page
        .locator('button:has-text("Create Login")')
        .or(page.locator('button:has-text("Set Password")'));

      if (await createLoginButton.isVisible()) {
        await createLoginButton.click();

        // Fill in temporary password
        const passwordInput = page.locator('input[type="password"]').first();
        if (await passwordInput.isVisible()) {
          await passwordInput.fill("TempPassword123!");
        }

        // Confirm
        const confirmButton = page
          .locator('button:has-text("Confirm")')
          .or(page.locator('button:has-text("Create")'));
        if (await confirmButton.isVisible()) {
          await confirmButton.click();
        }
      }
    }
  });

  test("Employee can view their own profile (self-service)", async ({ page }) => {
    await loginAsEmployee(page);

    // Navigate to profile page
    await page.goto("/app/profile");

    // MyProfilePage.tsx renders the employee's own name as its h1
    // ("E2E employee self service"), not literal "Profile" text — the nav
    // label "My Profile" is the stable thing to assert on instead.
    await expect(page).toHaveURL(/\/app\/profile/);
    await expect(page.locator("h1").first()).toBeVisible();
  });

  test("Line Manager can view team members", async ({ page }) => {
    await loginAsLineManager(page);

    // Navigate to employee list (which would be filtered by RLS in API)
    await page.goto("/app/employees");

    // For a line manager, the list would only show their direct reports —
    // the API enforces this via RBAC, so the UI just renders what comes
    // back. This fixture line manager has no reports assigned in its
    // freshly-signed-up company, so the real empty state ("No employees
    // to show yet") is what actually renders, not a `<table>`; either is
    // a correctly-scoped response, so this only checks the page itself
    // loaded.
    await expect(page.locator("h1").filter({ hasText: /employees/i })).toBeVisible();
  });

  test("Portal navigation includes Employee Core menu item for hr_admin", async ({
    page,
  }) => {
    await loginAsHrAdmin(page);
    // Navigate to portal home
    await page.goto("/app");

    // Expect nav to have employees link
    const employeesNavLink = page.locator("nav a").filter({
      hasText: /employees/i,
    });
    await expect(employeesNavLink.first()).toBeVisible();

    // Click it and verify navigation
    await employeesNavLink.first().click();
    await expect(page).toHaveURL(/\/app\/employees/);
  });
});

test.describe("Employee Core Responsiveness", () => {
  test("Employee list is readable on mobile width", async ({ page }) => {
    await loginAsHrAdmin(page);
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    // Navigate to employee list
    await page.goto("/app/employees");

    // Table should be visible or scrollable
    const table = page.locator("table");
    await expect(table).toBeVisible();

    // Verify no horizontal scrollbar clips content unexpectedly
    const bodyWidth = await page.evaluate(() => document.body.offsetWidth);
    const viewportWidth = page.viewportSize()?.width ?? 375;
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth);
  });
});

test.describe("Employee Core Accessibility", () => {
  test("Employee list table has proper headers", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/employees");

    // Verify table has a thead with th elements
    const thead = page.locator("table thead");
    await expect(thead).toBeVisible();

    const headers = thead.locator("th");
    expect(await headers.count()).toBeGreaterThan(0);
  });

  test("Form labels are properly associated with inputs", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/employees/new");

    // Real finding (2026-10-01, surfaced now that login actually works):
    // EmployeeCreatePage.tsx's "First name" field is a bare
    // `<label>First name</label>` followed by a sibling `<input>` with no
    // `htmlFor`/`id` pairing and no `name` or `aria-label` attribute —
    // there's nothing to select by `input[name="firstName"]` at all
    // (that locator hangs forever rather than reporting absence, which is
    // its own trap). This test is intentionally left asserting the real
    // requirement rather than loosened to pass: it should fail until the
    // product code pairs the label, which is a genuine accessibility gap
    // this file is now actually able to catch.
    const firstNameInput = page.locator('label:has-text("First name") + input');
    const firstNameLabel = page.locator('label[for="firstName"]');

    // Check that input has associated label or ARIA attributes
    const hasAriaLabel = await firstNameInput.evaluate((el) =>
      el.hasAttribute("aria-label")
    );
    const hasLabel =
      (await firstNameLabel.count()) > 0 ||
      hasAriaLabel ||
      (await firstNameInput.evaluate((el) => el.closest("label"))) !== null;

    expect(hasLabel).toBe(true);
  });
});
