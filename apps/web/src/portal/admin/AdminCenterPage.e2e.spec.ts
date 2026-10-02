import { test, expect, Page } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/**
 * Admin Center E2E Tests (Task #49)
 *
 * Real-session fix (2026-10-01): this file's own `loginAsHrAdmin` wrote a
 * fake "test-token" to the wrong localStorage key ("authToken" instead of
 * `api/client.ts`'s real `aihxm.platformAdminToken`) and never navigated
 * to `/app` afterward — see `real-session.ts`'s header comment for the
 * full writeup of why neither bug alone nor both together ever actually
 * logged anyone in. Every test here either asserted against the
 * unauthenticated `/login` redirect or silently no-op'd through an
 * `if (await x.isVisible())` guard.
 *
 * Rewriting against the real, authenticated page also surfaced a scope
 * mismatch: `AdminCenterPage.tsx` (Task #49) has five tabs — Employee
 * Groups, Leave Policies, Shifts & Work Schedule, Holidays, and
 * Onboarding & Offboarding — and no "Workflow Templates" tab at all.
 * Workflow template management lives on `/app/system-admin`
 * (`SystemAdminPage.e2e.spec.ts`), not here; the two "Workflow Template"
 * tests this file had are dropped rather than kept failing against a tab
 * that was simply never built on this page.
 */

async function loginAsHrAdmin(page: Page) {
  await loginToApp(page, getSharedSession("hr_admin"));
}

test.describe("Admin Center Portal (Task #49)", () => {
  test("HR Admin can view all five Admin Center tabs", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/admin");

    await expect(page.locator("h1")).toHaveText("Admin Center");

    // AdminCenterPage.tsx's own tabs are plain <button>s with no
    // role="tab" — the original `[role='tab']` locator this file used
    // elsewhere never matched any of them.
    for (const label of [
      "Employee Groups",
      "Leave Policies",
      "Shifts & Work Schedule",
      "Holidays",
      "Onboarding & Offboarding",
    ]) {
      await expect(page.locator("button", { hasText: label })).toBeVisible();
    }

    // Employee Groups is the default tab; a brand-new company has none yet.
    await expect(page.locator("text=No employee groups yet")).toBeVisible();
  });

  test("HR Admin can create an Employee Group with a condition", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/admin");

    await page.locator("button", { hasText: "New Group" }).click();

    const form = page.locator("form");
    await expect(form).toBeVisible();

    // GroupForm's labels have no htmlFor (see this file's accessibility
    // test below for the correctly-failing a11y gap this surfaces) — the
    // real DOM only has a label immediately followed by its control.
    const timestamp = Date.now();
    const groupName = `E2E Engineering ${timestamp}`;
    await form.locator("label", { hasText: "Name" }).locator("+ input").fill(groupName);
    await form
      .locator("label", { hasText: "Description (optional)" })
      .locator("+ input")
      .fill("Group for all engineering department members");

    // One condition row ships pre-filled (field="department", equals="")
    // — fill its "equals" value rather than adding a second row.
    await form.locator("input[placeholder='e.g. Engineering']").fill("Engineering");

    await page.locator("button", { hasText: "Create group" }).click();

    // GroupForm has no toast/success banner — onSaved() just closes the
    // form and reloads the list, so the new group's own card is the
    // real, only confirmation.
    await expect(page.locator("h3", { hasText: groupName })).toBeVisible({ timeout: 5000 });
  });

  test("HR Admin can view Leave Policies", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/admin");

    await page.locator("button", { hasText: "Leave Policies" }).click();

    await expect(page.locator("text=No leave policies yet")).toBeVisible();
  });

  test("HR Admin can create a Leave Policy", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/admin");

    await page.locator("button", { hasText: "Leave Policies" }).click();
    await page.locator("button", { hasText: "New Policy" }).click();

    const form = page.locator("form");
    await expect(form).toBeVisible();

    const timestamp = Date.now();
    const policyName = `E2E Custom Policy ${timestamp}`;
    // PolicyForm's "Name" label is ambiguous with DayField's own labels
    // only by substring, not exact text — `{ exact: true }` picks the
    // lone "Name" label over "Annual leave (days/yr)" etc.
    await form.locator("label", { hasText: "Name", exact: true }).locator("+ input").fill(policyName);
    await form.locator("label", { hasText: "Annual leave (days/yr)" }).locator("+ input").fill("20");
    await form.locator("label", { hasText: "Casual leave (days/yr)" }).locator("+ input").fill("10");
    await form.locator("label", { hasText: "Sick leave (days/yr)" }).locator("+ input").fill("8");

    await page.locator("button", { hasText: "Create policy" }).click();

    await expect(page.locator("text=" + policyName)).toBeVisible({ timeout: 5000 });
  });

  test("Portal navigation includes Admin Center menu item", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app");

    const adminNavLink = page.locator("nav a").filter({ hasText: "Admin Center" });
    await expect(adminNavLink).toBeVisible();

    await adminNavLink.click();
    await expect(page).toHaveURL(/\/app\/admin/);
  });
});

test.describe("Admin Center Responsiveness", () => {
  test("Employee Group form is usable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await loginAsHrAdmin(page);
    await page.goto("/app/admin");
    await page.locator("button", { hasText: "New Group" }).click();

    const form = page.locator("form");
    await expect(form).toBeVisible();

    const inputs = form.locator("input, select, textarea");
    const count = await inputs.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await inputs.nth(i).boundingBox();
      if (box) {
        expect(box.width).toBeLessThanOrEqual(375);
      }
    }
  });
});

test.describe("Admin Center Accessibility", () => {
  test("Employee Group form inputs have properly associated labels", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/admin");
    await page.locator("button", { hasText: "New Group" }).click();

    const form = page.locator("form");
    await expect(form).toBeVisible();

    // Genuine, pre-existing accessibility gap — same pattern already
    // found and deliberately left failing in EmployeeCreatePage's,
    // LeaveRequestForm's, and RequisitionForm's own e2e specs:
    // GroupForm's <label> elements have no `htmlFor`/`id`, and its
    // <input>/<select> elements have no `name` or `aria-label`. Left
    // failing on purpose so it keeps reporting the real gap.
    const firstInput = form.locator("input, select").first();
    const id = await firstInput.getAttribute("id");
    const hasAriaLabel = await firstInput.evaluate((el) => el.hasAttribute("aria-label"));
    const hasAssociatedLabel = id ? (await page.locator(`label[for="${id}"]`).count()) > 0 : false;

    expect(hasAssociatedLabel || hasAriaLabel).toBe(true);
  });
});
