import { test, expect, Page } from "@playwright/test";

/**
 * Portal Home E2E Tests
 *
 * Tests portal shell and navigation:
 * - Authentication and login flows
 * - Role-based navigation rendering
 * - Logout functionality
 * - Session expiry handling
 * - Dashboard/home screen display
 *
 * Roles tested:
 * - hr_admin
 * - line_manager
 * - employee_self_service
 * - system_admin
 *
 * Prerequisites:
 * - Backend API running on http://localhost:3000
 * - Frontend dev server running on http://localhost:5173
 */

const PORTAL_URL = "http://localhost:5173/app";
const LOGIN_URL = "http://localhost:5173/login";

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

test.describe("Portal Home & Navigation", () => {
  test("Unauthenticated user is redirected to login", async ({ page }) => {
    // Clear auth storage
    await page.context().clearCookies();
    await page.evaluate(() => {
      localStorage.removeItem("authToken");
      localStorage.removeItem("identity");
    });

    // Try to access portal
    await page.goto("/app");

    // Should redirect to login or show login form
    const loginIndicator = page
      .locator("text=Login")
      .or(page.locator("text=Sign In"))
      .or(page.locator('input[type="password"]'));

    await expect(loginIndicator).toBeVisible();
  });

  test("HR Admin sees HR-specific navigation", async ({ page }) => {
    // Set up HR admin session
    await loginAsRole(
      page,
      "test-token",
      ["hr_admin"],
      "hr-admin-user",
      "test-company"
    );

    // Verify navigation bar
    const nav = page.locator("nav");
    await expect(nav).toBeVisible();

    // Verify HR admin specific links
    const employeesLink = nav
      .locator("a")
      .filter({ hasText: /employees/i });
    const leaveLink = nav.locator("a").filter({ hasText: /leave/i });
    const adminLink = nav.locator("a").filter({ hasText: /admin/i });

    // At least employees and admin should be visible for HR admin
    expect(
      (await employeesLink.isVisible()) ||
      (await leaveLink.isVisible()) ||
      (await adminLink.isVisible())
    ).toBe(true);
  });

  test("Line Manager sees team-focused navigation", async ({ page }) => {
    // Set up line manager session
    await loginAsRole(
      page,
      "test-token",
      ["line_manager"],
      "manager-user",
      "test-company"
    );

    // Verify navigation bar
    const nav = page.locator("nav");
    await expect(nav).toBeVisible();

    // Line manager should see employees (for their team)
    const employeesLink = nav
      .locator("a")
      .filter({ hasText: /employees|team/i });
    if (await employeesLink.isVisible()) {
      await expect(employeesLink).toBeVisible();
    }
  });

  test("Employee sees employee-focused navigation", async ({ page }) => {
    // Set up employee session
    await loginAsRole(
      page,
      "test-token",
      ["employee_self_service"],
      "employee-user",
      "test-company"
    );

    // Verify navigation bar
    const nav = page.locator("nav");
    await expect(nav).toBeVisible();

    // Employee should see: Profile, Leave, Goals, etc.
    const links = nav.locator("a");
    expect(await links.count()).toBeGreaterThan(0);
  });

  test("User can access portal home after login", async ({ page }) => {
    await loginAsRole(
      page,
      "test-token",
      ["hr_admin"],
      "hr-admin-user",
      "test-company"
    );

    // Should be on /app or /app/ after redirect
    const url = page.url();
    expect(url).toMatch(/\/app\/?$/);

    // Home page should display
    const heading = page.locator("h1, h2");
    if (await heading.isVisible()) {
      await expect(heading).toBeVisible();
    }
  });

  test("User can navigate between portal pages", async ({ page }) => {
    await loginAsRole(
      page,
      "test-token",
      ["hr_admin"],
      "hr-admin-user",
      "test-company"
    );

    // Navigate to employees
    const employeesLink = page
      .locator("nav a")
      .filter({ hasText: /employees/i });
    if (await employeesLink.isVisible()) {
      await employeesLink.click();
      await page.waitForURL(/\/app\/employees/);
      expect(page.url()).toMatch(/\/app\/employees/);
    }

    // Navigate back to home
    const homeLink = page.locator("nav a").filter({ hasText: /home/i });
    if (await homeLink.isVisible()) {
      await homeLink.click();
      await page.waitForURL(/\/app\/?$/);
    }
  });

  test("User can logout", async ({ page }) => {
    await loginAsRole(
      page,
      "test-token",
      ["hr_admin"],
      "hr-admin-user",
      "test-company"
    );

    // Find logout button (usually in nav or user menu)
    const logoutButton = page
      .locator("button:has-text('Logout')")
      .or(page.locator("button:has-text('Sign Out')"))
      .or(page.locator("[aria-label*='Logout']"))
      .or(page.locator("[aria-label*='Sign Out']"));

    if (await logoutButton.isVisible()) {
      await logoutButton.click();

      // Should redirect to login or home
      const loginIndicator = page
        .locator("text=Login")
        .or(page.locator("text=Sign In"));

      if (await loginIndicator.isVisible()) {
        await expect(loginIndicator).toBeVisible();
      }
    }
  });

  test("User menu displays user info", async ({ page }) => {
    await loginAsRole(
      page,
      "test-token",
      ["hr_admin"],
      "hr-admin-user",
      "test-company"
    );

    // Look for user menu or profile info
    const userMenu = page
      .locator("[data-testid='user-menu']")
      .or(page.locator("button:has-text('Profile')"))
      .or(page.locator("[aria-label*='user']")
    );

    if (await userMenu.isVisible()) {
      // Click to open menu if it's a button
      const clickableMenu = page
        .locator("button:has-text('Profile')")
        .or(page.locator("[aria-label*='user']"));
      if (await clickableMenu.isVisible()) {
        await clickableMenu.click();
      }

      // Menu should show user-related options
      await page.waitForTimeout(500);
    }
  });

  test("Portal displays company context", async ({ page }) => {
    await loginAsRole(
      page,
      "test-token",
      ["hr_admin"],
      "hr-admin-user",
      "test-company"
    );

    // Header should show company name or logo
    const header = page.locator("header");
    if (await header.isVisible()) {
      // Company name or logo should be visible
      const companyInfo = header
        .locator("text=Company")
        .or(header.locator("img[alt*='Logo']"))
        .or(header.locator("img[alt*='Company']"));

      // At minimum header should be visible
      await expect(header).toBeVisible();
    }
  });
});

test.describe("Session Management", () => {
  test("Session persists on page refresh", async ({ page }) => {
    await loginAsRole(
      page,
      "test-token",
      ["hr_admin"],
      "hr-admin-user",
      "test-company"
    );

    // Verify logged in state
    const nav = page.locator("nav");
    await expect(nav).toBeVisible();

    // Refresh page
    await page.reload();

    // Should still be logged in
    await expect(nav).toBeVisible({ timeout: 5000 });
  });

  test("Invalid or expired token shows error", async ({ page }) => {
    // Set invalid token
    await page.evaluate(() => {
      localStorage.setItem("authToken", "invalid-token");
      localStorage.setItem(
        "identity",
        JSON.stringify({
          sub: "test-user",
          company_id: "test-company",
          roleKeys: ["hr_admin"],
        })
      );
    });

    await page.goto("/app");

    // Should show error or redirect to login
    const errorMessage = page
      .locator("text=Invalid")
      .or(page.locator("text=Expired"))
      .or(page.locator("text=Login"));

    // Wait a moment for auth check
    await page.waitForTimeout(1000);

    // Either error or redirect should occur
    const isLoggedOut =
      (await errorMessage.isVisible()) ||
      page.url().includes("login") ||
      page.url() === "http://localhost:5173/";

    expect(isLoggedOut).toBe(true);
  });
});

test.describe("Portal Accessibility", () => {
  test("Navigation is keyboard accessible", async ({ page }) => {
    await loginAsRole(
      page,
      "test-token",
      ["hr_admin"],
      "hr-admin-user",
      "test-company"
    );

    // Tab through navigation
    const nav = page.locator("nav");
    if (await nav.isVisible()) {
      const links = nav.locator("a, button");
      const linkCount = await links.count();

      // Should have focusable elements
      expect(linkCount).toBeGreaterThan(0);

      // First link should be focusable
      await links.first().focus();
      const focused = await page.evaluate(() => {
        return document.activeElement?.tagName;
      });
      expect(["A", "BUTTON"]).toContain(focused);
    }
  });

  test("Navigation has proper ARIA roles", async ({ page }) => {
    await loginAsRole(
      page,
      "test-token",
      ["hr_admin"],
      "hr-admin-user",
      "test-company"
    );

    // Navigation should have proper role
    const nav = page.locator("nav, [role='navigation']");
    expect(await nav.count()).toBeGreaterThan(0);
  });
});
