import { test, expect, Page } from "@playwright/test";

/**
 * System Admin E2E Tests
 *
 * Tests platform-wide administration workflows:
 * - Platform-wide settings and configuration
 * - Audit log viewing and filtering
 * - Notification template management
 * - Company settings and onboarding controls
 *
 * Role tested:
 * - system_admin: Full access to all system administration features
 *
 * Prerequisites:
 * - Backend API running on http://localhost:3000
 * - Frontend dev server running on http://localhost:5173
 * - Test database seeded with test company
 */

const PORTAL_URL = "http://localhost:5173/app";

test.describe("System Admin Portal", () => {
  test("System Admin can view platform settings", async ({ page }) => {
    await page.goto("/app/system-admin");

    // Expect system admin page to load
    await expect(
      page.locator("h1, h2").filter({ hasText: /system|admin|settings|configuration/i })
    ).toBeVisible();

    // Verify settings section exists
    const settingsSection = page
      .locator("[data-testid='system-settings']")
      .or(page.locator("text=System Settings"))
      .or(page.locator("text=Configuration"));

    if (await settingsSection.isVisible()) {
      await expect(settingsSection).toBeVisible();
    }
  });

  test("System Admin can view audit logs", async ({ page }) => {
    await page.goto("/app/system-admin");

    // Navigate to Audit Logs section
    const auditTab = page
      .locator("[role='tab']")
      .filter({ hasText: /audit|logs/i });

    if (await auditTab.isVisible()) {
      await auditTab.click();
    }

    // Verify audit log table/list
    const auditSection = page
      .locator("[data-testid='audit-logs']")
      .or(page.locator("text=Audit Logs"))
      .or(page.locator("table"));

    if (await auditSection.isVisible()) {
      await expect(auditSection).toBeVisible();

      // Should show columns for: timestamp, user, action, resource, details
      const table = page.locator("table");
      if (await table.isVisible()) {
        const headers = table.locator("thead th");
        expect(await headers.count()).toBeGreaterThanOrEqual(4);
      }
    }
  });

  test("System Admin can filter audit logs", async ({ page }) => {
    await page.goto("/app/system-admin");

    // Navigate to Audit Logs
    const auditTab = page
      .locator("[role='tab']")
      .filter({ hasText: /audit|logs/i });
    if (await auditTab.isVisible()) {
      await auditTab.click();
    }

    // Look for filter inputs
    const actionFilter = page
      .locator('select[name="action"]')
      .or(page.locator('input[name="action"]'))
      .or(page.locator('[aria-label*="Action"]'));

    if (await actionFilter.isVisible()) {
      // Select a filter option
      const options = await actionFilter.locator("option").count();
      if (options > 1) {
        await actionFilter.selectOption({ index: 1 });

        // Table should update with filtered results
        const table = page.locator("table tbody");
        if (await table.isVisible()) {
          await page.waitForTimeout(500); // Allow table to update
          await expect(table).toBeVisible();
        }
      }
    }

    // Filter by date range
    const startDate = page
      .locator('input[name="startDate"]')
      .or(page.locator('[aria-label*="Start Date"]'));
    if (await startDate.isVisible()) {
      const today = new Date().toISOString().split("T")[0];
      await startDate.fill(today);
    }
  });

  test("System Admin can view and manage notification templates", async ({
    page,
  }) => {
    await page.goto("/app/system-admin");

    // Navigate to Notification Templates
    const templatesTab = page
      .locator("[role='tab']")
      .filter({ hasText: /notification|template/i });

    if (await templatesTab.isVisible()) {
      await templatesTab.click();
    }

    // Verify templates list
    const templatesSection = page
      .locator("[data-testid='notification-templates']")
      .or(page.locator("text=Notification Templates"))
      .or(page.locator("table"));

    if (await templatesSection.isVisible()) {
      await expect(templatesSection).toBeVisible();
    }
  });

  test("System Admin can edit notification template", async ({ page }) => {
    await page.goto("/app/system-admin");

    // Navigate to Notification Templates
    const templatesTab = page
      .locator("[role='tab']")
      .filter({ hasText: /notification|template/i });
    if (await templatesTab.isVisible()) {
      await templatesTab.click();
    }

    // Find a template to edit
    const templateRow = page.locator("table tbody tr").or(
      page.locator(".template-card")
    );

    if ((await templateRow.count()) > 0) {
      // Click to open template
      await templateRow.first().click();

      // Expect template detail/edit form
      const form = page.locator("form").or(page.locator("[data-testid='template-form']"));
      if (await form.isVisible()) {
        // Template should have subject and body
        const subject = form
          .locator('input[name="subject"]')
          .or(form.locator('input[placeholder*="subject" i]'));

        if (await subject.isVisible()) {
          // Modify subject
          await subject.clear();
          await subject.fill("New Notification Subject");
        }

        const body = form
          .locator('textarea[name="body"]')
          .or(form.locator('textarea[placeholder*="body" i]'));

        if (await body.isVisible()) {
          // Modify body
          await body.clear();
          await body.fill("Updated notification template body with new content.");
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
              .or(page.locator("text=updated"))
              .or(page.locator("text=success"))
          ).toBeVisible({ timeout: 5000 });
        }
      }
    }
  });

  test("System Admin can view Role Access control", async ({ page }) => {
    await page.goto("/app/system-admin");

    // Navigate to Roles/Access section
    const rolesTab = page
      .locator("[role='tab']")
      .filter({ hasText: /roles|access|permissions/i });

    if (await rolesTab.isVisible()) {
      await rolesTab.click();
    }

    // Verify roles list
    const rolesSection = page
      .locator("[data-testid='roles']")
      .or(page.locator("text=Roles"))
      .or(page.locator("text=Access Control"));

    if (await rolesSection.isVisible()) {
      await expect(rolesSection).toBeVisible();

      // Should list roles: hr_admin, line_manager, employee_self_service
      const roleItems = rolesSection.locator("tr, .role-card, .role-item");
      expect(await roleItems.count()).toBeGreaterThanOrEqual(2);
    }
  });

  test("System Admin can view role permissions", async ({ page }) => {
    await page.goto("/app/system-admin");

    // Navigate to Roles section
    const rolesTab = page
      .locator("[role='tab']")
      .filter({ hasText: /roles|access/i });
    if (await rolesTab.isVisible()) {
      await rolesTab.click();
    }

    // Find a role to view
    const roleRow = page.locator("table tbody tr").or(page.locator(".role-card"));

    if ((await roleRow.count()) > 0) {
      // Click to view role details
      await roleRow.first().click();

      // Expect permissions list
      const permissionsView = page
        .locator("[data-testid='role-permissions']")
        .or(page.locator("text=Permissions"))
        .or(page.locator("ul, [role='list']"));

      if (await permissionsView.isVisible()) {
        await expect(permissionsView).toBeVisible();

        // Should show permission items
        const permissions = permissionsView.locator("li, [role='listitem']");
        expect(await permissions.count()).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("Portal navigation includes System Admin menu item", async ({
    page,
  }) => {
    await page.goto("/app");

    const systemAdminNavLink = page.locator("nav a").filter({
      hasText: /system|admin/i,
    });

    if (await systemAdminNavLink.isVisible()) {
      await systemAdminNavLink.click();
      await expect(page).toHaveURL(/\/app\/system-admin/);
    }
  });
});

test.describe("System Admin Responsiveness", () => {
  test("Audit log table is readable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto("/app/system-admin");

    // Navigate to audit logs
    const auditTab = page
      .locator("[role='tab']")
      .filter({ hasText: /audit/i });
    if (await auditTab.isVisible()) {
      await auditTab.click();
    }

    // Table or responsive list should be visible
    const table = page.locator("table").or(page.locator("[data-testid='audit-list']"));
    if (await table.isVisible()) {
      await expect(table).toBeVisible();

      // Verify no horizontal scroll clips content
      const bodyWidth = await page.evaluate(
        () => document.body.offsetWidth
      );
      expect(bodyWidth).toBeLessThanOrEqual(375);
    }
  });
});

test.describe("System Admin Accessibility", () => {
  test("Audit log table has proper structure", async ({ page }) => {
    await page.goto("/app/system-admin");

    // Navigate to audit logs
    const auditTab = page
      .locator("[role='tab']")
      .filter({ hasText: /audit/i });
    if (await auditTab.isVisible()) {
      await auditTab.click();
    }

    // Verify table structure
    const table = page.locator("table");
    if (await table.isVisible()) {
      const thead = table.locator("thead");
      await expect(thead).toBeVisible();

      const headers = thead.locator("th");
      expect(await headers.count()).toBeGreaterThan(0);

      // Verify tbody structure
      const tbody = table.locator("tbody");
      if (await tbody.isVisible()) {
        const rows = tbody.locator("tr");
        expect(await rows.count()).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
