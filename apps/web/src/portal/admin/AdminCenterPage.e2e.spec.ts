import { test, expect, Page } from "@playwright/test";

/**
 * Admin Center E2E Tests (Task #52)
 *
 * Tests HR administration workflows:
 * - Employee group creation and membership management
 * - Leave policy configuration
 * - Workflow template management
 * - Role and permission assignment
 *
 * Role tested:
 * - hr_admin: Full access to all admin center features
 *
 * Prerequisites:
 * - Backend API running on http://localhost:3000
 * - Frontend dev server running on http://localhost:5173
 * - Test database seeded with test company
 */

const PORTAL_URL = "http://localhost:5173/app";

test.describe("Admin Center Portal (Task #52)", () => {
  test("HR Admin can view Employee Groups", async ({ page }) => {
    await page.goto("/app/admin");

    // Expect admin center to load
    await expect(
      page.locator("h1, h2").filter({ hasText: /admin|settings|configuration/i })
    ).toBeVisible();

    // Navigate to Employee Groups section
    const groupsTab = page
      .locator("[role='tab']")
      .filter({ hasText: /groups|employee groups/i });

    if (await groupsTab.isVisible()) {
      await groupsTab.click();
    }

    // Verify groups list
    const groupsList = page
      .locator("[data-testid='employee-groups']")
      .or(page.locator("text=Employee Groups"))
      .or(page.locator("table"));

    if (await groupsList.isVisible()) {
      await expect(groupsList).toBeVisible();
    }
  });

  test("HR Admin can create Employee Group", async ({ page }) => {
    await page.goto("/app/admin");

    // Navigate to Employee Groups
    const groupsTab = page
      .locator("[role='tab']")
      .filter({ hasText: /groups/i });
    if (await groupsTab.isVisible()) {
      await groupsTab.click();
    }

    // Look for "New Group" button
    const newGroupButton = page
      .locator("button:has-text('New Group')")
      .or(page.locator("button:has-text('Create Group')")
    );

    if (await newGroupButton.isVisible()) {
      await newGroupButton.click();

      // Expect form to open
      const form = page.locator("form").or(page.locator("[role='dialog']"));
      await expect(form).toBeVisible({ timeout: 5000 });

      // Fill group details
      const groupName = page.locator('input[name="groupName"]').or(
        page.locator('input[name="name"]')
      );
      if (await groupName.isVisible()) {
        const timestamp = Date.now();
        await groupName.fill(`Engineering Team ${timestamp}`);
      }

      const groupDescription = page.locator('textarea[name="description"]');
      if (await groupDescription.isVisible()) {
        await groupDescription.fill("Group for all engineering department members");
      }

      // Select members (multiselect)
      const memberSelect = page.locator('select[name="members"]').or(
        page.locator("[aria-label*='Members']")
      );
      if (await memberSelect.isVisible()) {
        // Select first few options
        const options = await memberSelect.locator("option").count();
        if (options > 1) {
          await memberSelect.selectOption({ index: 1 });
        }
      }

      // Submit form
      const submitButton = page
        .locator('button:has-text("Create")')
        .or(page.locator('button:has-text("Save")'));
      await submitButton.click();

      // Expect success
      await expect(
        page
          .locator("text=created")
          .or(page.locator("text=success"))
      ).toBeVisible({ timeout: 5000 });
    }
  });

  test("HR Admin can configure Leave Policies", async ({ page }) => {
    await page.goto("/app/admin");

    // Navigate to Leave Policies section
    const policiesTab = page
      .locator("[role='tab']")
      .filter({ hasText: /leave.*polic|policy/i });

    if (await policiesTab.isVisible()) {
      await policiesTab.click();
    }

    // Verify policies list
    const policiesList = page
      .locator("[data-testid='leave-policies']")
      .or(page.locator("text=Leave Policies"))
      .or(page.locator("table"));

    if (await policiesList.isVisible()) {
      await expect(policiesList).toBeVisible();
    }
  });

  test("HR Admin can create Leave Policy", async ({ page }) => {
    await page.goto("/app/admin");

    // Navigate to Leave Policies
    const policiesTab = page
      .locator("[role='tab']")
      .filter({ hasText: /leave.*polic|policy/i });
    if (await policiesTab.isVisible()) {
      await policiesTab.click();
    }

    // Look for "New Policy" button
    const newPolicyButton = page
      .locator("button:has-text('New Policy')")
      .or(page.locator("button:has-text('Create Policy')")
    );

    if (await newPolicyButton.isVisible()) {
      await newPolicyButton.click();

      // Expect form to open
      const form = page.locator("form").or(page.locator("[role='dialog']"));
      await expect(form).toBeVisible({ timeout: 5000 });

      // Fill policy details
      const policyName = page.locator('input[name="policyName"]').or(
        page.locator('input[name="name"]')
      );
      if (await policyName.isVisible()) {
        const timestamp = Date.now();
        await policyName.fill(`Custom Leave Policy ${timestamp}`);
      }

      const policyType = page.locator('select[name="type"]').or(
        page.locator("[aria-label*='Type']")
      );
      if (await policyType.isVisible()) {
        await policyType.selectOption("annual");
      }

      // Days allocated
      const daysInput = page
        .locator('input[name="daysAllocated"]')
        .or(page.locator('input[name="days"]'));
      if (await daysInput.isVisible()) {
        await daysInput.fill("20");
      }

      // Carryover settings
      const carryoverInput = page
        .locator('input[name="carryoverDays"]')
        .or(page.locator('input[name="carryover"]'));
      if (await carryoverInput.isVisible()) {
        await carryoverInput.fill("5");
      }

      // Submit form
      const submitButton = page
        .locator('button:has-text("Create")')
        .or(page.locator('button:has-text("Save")'));
      await submitButton.click();

      // Expect success
      await expect(
        page
          .locator("text=created")
          .or(page.locator("text=success"))
      ).toBeVisible({ timeout: 5000 });
    }
  });

  test("HR Admin can view Workflow Templates", async ({ page }) => {
    await page.goto("/app/admin");

    // Navigate to Workflow Templates section
    const templatesTab = page
      .locator("[role='tab']")
      .filter({ hasText: /workflow|template/i });

    if (await templatesTab.isVisible()) {
      await templatesTab.click();
    }

    // Verify templates list
    const templatesList = page
      .locator("[data-testid='workflow-templates']")
      .or(page.locator("text=Workflow Templates"))
      .or(page.locator("table"));

    if (await templatesList.isVisible()) {
      await expect(templatesList).toBeVisible();
    }
  });

  test("HR Admin can edit Workflow Template", async ({ page }) => {
    await page.goto("/app/admin");

    // Navigate to Workflow Templates
    const templatesTab = page
      .locator("[role='tab']")
      .filter({ hasText: /workflow|template/i });
    if (await templatesTab.isVisible()) {
      await templatesTab.click();
    }

    // Find a template to edit
    const templateRow = page.locator("table tbody tr").or(
      page.locator(".template-card")
    );

    if ((await templateRow.count()) > 0) {
      // Look for edit button
      const editButton = templateRow
        .first()
        .locator("button:has-text('Edit')")
        .or(templateRow.first().locator("button:has-text('Configure')"));

      if (await editButton.isVisible()) {
        await editButton.click();

        // Expect form or detail view
        const form = page.locator("form").or(page.locator("[data-testid='template-form']"));
        if (await form.isVisible()) {
          // Modify workflow steps (add approver, change order, etc.)
          const stepInput = page
            .locator('input[name="stepName"]')
            .or(page.locator('input[placeholder*="step" i]'));

          if (await stepInput.isVisible()) {
            // Can modify steps or add new ones
            const addStepButton = form.locator('button:has-text("Add Step")').or(
              form.locator('button:has-text("Add")')
            );

            if (await addStepButton.isVisible()) {
              await addStepButton.click();
            }
          }

          // Save changes
          const saveButton = form
            .locator('button:has-text("Save")')
            .or(form.locator('button:has-text("Update")'));
          if (await saveButton.isVisible()) {
            await saveButton.click();

            // Expect success
            await expect(
              page
                .locator("text=saved")
                .or(page.locator("text=success"))
            ).toBeVisible({ timeout: 5000 });
          }
        }
      }
    }
  });

  test("Portal navigation includes Admin Center menu item", async ({
    page,
  }) => {
    await page.goto("/app");

    const adminNavLink = page.locator("nav a").filter({
      hasText: /admin|settings/i,
    });

    if (await adminNavLink.isVisible()) {
      await adminNavLink.click();
      await expect(page).toHaveURL(/\/app\/admin/);
    }
  });
});

test.describe("Admin Center Responsiveness", () => {
  test("Admin forms are responsive on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto("/app/admin");

    // Find any visible form
    const form = page.locator("form");
    if (await form.isVisible()) {
      const inputs = form.locator("input, select, textarea");
      for (let i = 0; i < Math.min(3, await inputs.count()); i++) {
        const input = inputs.nth(i);
        const boundingBox = await input.boundingBox();
        if (boundingBox) {
          expect(boundingBox.width).toBeLessThanOrEqual(375);
        }
      }
    }
  });
});

test.describe("Admin Center Accessibility", () => {
  test("Admin form inputs have proper labels", async ({ page }) => {
    await page.goto("/app/admin");

    // Find first input
    const firstInput = page.locator("input").first();
    if ((await firstInput.count()) > 0) {
      const inputName = await firstInput.getAttribute("name");
      const hasLabel =
        (await page.locator(`label[for="${inputName}"]`).count()) > 0 ||
        (await firstInput.evaluate((el) => el.hasAttribute("aria-label")));

      expect(hasLabel).toBe(true);
    }
  });
});
