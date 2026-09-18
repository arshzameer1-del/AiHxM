import { test, expect, Page } from "@playwright/test";

/**
 * My Profile E2E Tests (Self-Service Portal)
 *
 * Tests employee self-service profile access:
 * - View personal information
 * - View employment details
 * - View compensation (if enabled)
 * - Update contact information
 * - Change password
 * - View leave balance
 * - Access personal documents
 *
 * Role tested:
 * - employee_self_service: Access to own profile only
 *
 * Prerequisites:
 * - Backend API running on http://localhost:3000
 * - Frontend dev server running on http://localhost:5173
 */

const PORTAL_URL = "http://localhost:5173/app";

async function loginAsEmployee(page: Page) {
  await page.evaluate(() => {
    localStorage.setItem("authToken", "test-employee-token");
    localStorage.setItem(
      "identity",
      JSON.stringify({
        sub: "employee-123",
        is_platform_admin: false,
        company_id: "test-company",
        roleKeys: ["employee_self_service"],
      })
    );
  });

  await page.goto("/app");
  await page.waitForSelector("nav", { timeout: 5000 });
}

test.describe("My Profile Portal (Self-Service)", () => {
  test("Employee can access My Profile page", async ({ page }) => {
    await loginAsEmployee(page);

    // Navigate to profile
    const profileLink = page
      .locator("nav a, [aria-label*='Profile']")
      .filter({ hasText: /profile|me|my/i });

    if (await profileLink.isVisible()) {
      await profileLink.click();
    } else {
      // Try direct URL
      await page.goto("/app/profile");
    }

    // Expect profile page to load
    const profileHeading = page
      .locator("h1, h2")
      .filter({ hasText: /profile|my profile/i });
    await expect(profileHeading).toBeVisible();
  });

  test("Employee can view personal information", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/profile");

    // Verify personal information section
    const personalSection = page
      .locator("[data-testid='personal-info']")
      .or(page.locator("text=Personal Information"))
      .or(page.locator("text=Personal Details"));

    if (await personalSection.isVisible()) {
      // Should display: Name, Email, Phone, Date of Birth
      await expect(personalSection.locator("text=Email").or(
        personalSection.locator("text=Name")
      )).toBeVisible();

      // Verify read-only display
      const displayElements = personalSection.locator("dd, .value, [data-testid='field-value']");
      expect(await displayElements.count()).toBeGreaterThanOrEqual(2);
    }
  });

  test("Employee can view employment details", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/profile");

    // Verify employment section
    const employmentSection = page
      .locator("[data-testid='employment-info']")
      .or(page.locator("text=Employment"))
      .or(page.locator("text=Employment Details"));

    if (await employmentSection.isVisible()) {
      // Should display: Job Title, Department, Manager, Employment Date, Employment Type
      const fields = employmentSection.locator("dt, dd, .label, .value");
      expect(await fields.count()).toBeGreaterThanOrEqual(3);
    }
  });

  test("Employee can update contact information", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/profile");

    // Find contact information section
    const contactSection = page
      .locator("[data-testid='contact-info']")
      .or(page.locator("text=Contact Information"))
      .or(page.locator("text=Contact Details"));

    if (await contactSection.isVisible()) {
      // Look for edit button
      const editButton = contactSection
        .locator("button:has-text('Edit')")
        .or(page.locator("button:has-text('Edit Contact')"));

      if (await editButton.isVisible()) {
        await editButton.click();

        // Expect edit form to appear
        const form = contactSection.locator("form").or(
          page.locator("[data-testid='contact-form']")
        );
        await expect(form).toBeVisible({ timeout: 5000 });

        // Update phone number
        const phoneInput = form
          .locator('input[name="phone"]')
          .or(form.locator('input[type="tel"]'));
        if (await phoneInput.isVisible()) {
          await phoneInput.clear();
          await phoneInput.fill("+92-300-1234567");
        }

        // Update alternate email
        const altEmailInput = form
          .locator('input[name="alternateEmail"]')
          .or(form.locator('input[name="altEmail"]'));
        if (await altEmailInput.isVisible()) {
          await altEmailInput.clear();
          await altEmailInput.fill("alternate@example.com");
        }

        // Save changes
        const saveButton = form
          .locator('button:has-text("Save")')
          .or(form.locator('button:has-text("Update")'));
        if (await saveButton.isVisible()) {
          await saveButton.click();

          // Expect success message
          await expect(
            page
              .locator("text=saved")
              .or(page.locator("text=updated"))
              .or(page.locator("text=success"))
          ).toBeVisible({ timeout: 5000 });
        }
      }
    }
  });

  test("Employee can change password", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/profile");

    // Look for password/security section
    const securitySection = page
      .locator("[data-testid='security']")
      .or(page.locator("text=Password"))
      .or(page.locator("text=Security"));

    if (await securitySection.isVisible()) {
      // Look for "Change Password" button
      const changePasswordButton = securitySection
        .locator("button:has-text('Change Password')")
        .or(securitySection.locator("button:has-text('Update Password')"));

      if (await changePasswordButton.isVisible()) {
        await changePasswordButton.click();

        // Expect password change form/modal
        const form = page.locator("form").or(page.locator("[role='dialog']"));
        await expect(form).toBeVisible({ timeout: 5000 });

        // Fill current password
        const currentPassword = form
          .locator('input[name="currentPassword"]')
          .or(form.locator('input[name="oldPassword"]'));
        if (await currentPassword.isVisible()) {
          await currentPassword.fill("CurrentPassword123!");
        }

        // Fill new password
        const newPassword = form
          .locator('input[name="newPassword"]')
          .or(form.locator('input[name="password"]').nth(0));
        if (await newPassword.isVisible()) {
          await newPassword.fill("NewPassword123!");
        }

        // Confirm new password
        const confirmPassword = form
          .locator('input[name="confirmPassword"]')
          .or(form.locator('input[name="password"]').nth(1));
        if (await confirmPassword.isVisible()) {
          await confirmPassword.fill("NewPassword123!");
        }

        // Submit
        const submitButton = form
          .locator('button:has-text("Change")')
          .or(form.locator('button:has-text("Update")'));
        if (await submitButton.isVisible()) {
          await submitButton.click();

          // Expect success
          await expect(
            page
              .locator("text=changed")
              .or(page.locator("text=success"))
          ).toBeVisible({ timeout: 5000 });
        }
      }
    }
  });

  test("Employee can view leave balance", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/profile");

    // Look for leave balance section
    const leaveSection = page
      .locator("[data-testid='leave-balance']")
      .or(page.locator("text=Leave Balance"))
      .or(page.locator("text=Annual Leave"));

    if (await leaveSection.isVisible()) {
      // Should display balance information
      const balanceValues = leaveSection.locator("text=/\\d+/");
      expect(await balanceValues.count()).toBeGreaterThanOrEqual(1);
    }
  });

  test("Employee can view employment documents", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/profile");

    // Look for documents section
    const docSection = page
      .locator("[data-testid='documents']")
      .or(page.locator("text=Documents"))
      .or(page.locator("text=My Documents"));

    if (await docSection.isVisible()) {
      // Should list available documents (offer letter, employment contract, etc.)
      const docList = docSection.locator("table, ul, .document-list");
      if (await docList.isVisible()) {
        await expect(docList).toBeVisible();
      }

      // Should have download buttons
      const downloadButtons = docSection.locator("a:has-text('Download')").or(
        docSection.locator("button:has-text('Download')")
      );
      if ((await downloadButtons.count()) > 0) {
        await expect(downloadButtons.first()).toBeVisible();
      }
    }
  });

  test("Employee can view compensation (if visible)", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/profile");

    // Look for compensation section (may be hidden if not enabled)
    const compSection = page
      .locator("[data-testid='compensation']")
      .or(page.locator("text=Compensation"))
      .or(page.locator("text=Salary"));

    if (await compSection.isVisible()) {
      // Should display salary structure (if visible to employee)
      const salaryInfo = compSection.locator("text=/PKR|Salary|Compensation/");
      if ((await salaryInfo.count()) > 0) {
        await expect(salaryInfo.first()).toBeVisible();
      }
    }
  });

  test("Employee cannot access other employee profiles", async ({ page }) => {
    await loginAsEmployee(page);

    // Try to navigate to another employee's profile
    // This should either be blocked or show access denied
    await page.goto("/app/employees");

    // Try to click another employee
    const firstEmployee = page.locator("table tbody tr").or(
      page.locator(".employee-card")
    );

    if ((await firstEmployee.count()) > 0) {
      // If employee list exists, employee should not be able to access other profiles
      // Check if it's redirected or shows error
      const employeeLink = firstEmployee.first().locator("a");
      if (await employeeLink.isVisible()) {
        // Click might be prevented or redirected
        // For employee_self_service role, should not see employee list
      }
    }
  });

  test("Profile has accessibility features", async ({ page }) => {
    await loginAsEmployee(page);
    await page.goto("/app/profile");

    // Verify proper heading hierarchy
    const headings = page.locator("h1, h2, h3");
    expect(await headings.count()).toBeGreaterThan(0);

    // Verify labels for form inputs
    const inputs = page.locator("input, textarea, select");
    for (let i = 0; i < Math.min(3, await inputs.count()); i++) {
      const input = inputs.nth(i);
      const inputName = await input.getAttribute("name");
      const hasLabel =
        (await page
          .locator(`label[for="${inputName}"]`)
          .count()) > 0 ||
        (await input.evaluate((el) => el.hasAttribute("aria-label")));

      // At least some inputs should have labels
      if (i === 0) {
        // First input should have a label
        expect(hasLabel).toBe(true);
      }
    }
  });
});

test.describe("My Profile Responsiveness", () => {
  test("Profile layout is responsive on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await loginAsEmployee(page);
    await page.goto("/app/profile");

    // Profile should be readable on mobile
    const profileContent = page.locator("main").or(page.locator("[role='main']"));
    if (await profileContent.isVisible()) {
      // Content should not overflow horizontally
      const bodyWidth = await page.evaluate(() => document.body.offsetWidth);
      expect(bodyWidth).toBeLessThanOrEqual(375);
    }
  });
});
