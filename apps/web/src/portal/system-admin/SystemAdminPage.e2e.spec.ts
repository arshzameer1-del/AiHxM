import { test, expect, Page } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/**
 * System Admin E2E Tests (Task #52, Decision #20)
 *
 * Real-session fix (2026-10-01): same missing/fake-auth bug as
 * `AdminCenterPage.e2e.spec.ts` (see that file's header comment for the
 * full root-cause writeup) — this file's own `loginAsSystemAdmin` wrote a
 * fake token to the wrong localStorage key and never navigated to `/app`
 * afterward, so every test here either hit the unauthenticated `/login`
 * redirect or silently no-op'd through an `if (await x.isVisible())`
 * guard.
 *
 * Rewriting against the real, authenticated page also surfaced a scope
 * mismatch: `SystemAdminPage.tsx` (Task #52) has exactly three tabs —
 * Workflow Templates, Roles & Access, and Configuration. There is no
 * Audit Logs tab and no Notification Templates tab anywhere in this
 * app — grep confirms neither phrase exists in any portal component.
 * Every "audit log" and "notification template" test this file had is
 * dropped rather than kept failing against tabs that were never built.
 *
 * One genuinely useful finding this rewrite turned up: the Workflow
 * Templates tab is the real, self-service fix for the "no active
 * workflow template" 404 `RecruitmentPage.e2e.spec.ts`'s "Submitting a
 * requisition for approval" test documents — a System Admin configuring
 * the "Recruitment requisition approval" template here is what's
 * actually missing from a freshly-signed-up company, not a code bug.
 * This file's own "can configure a workflow template" test below
 * exercises that same screen for the Payroll run template instead (to
 * avoid two spec files racing to configure the same one on the shared
 * company), as a real, live demonstration that the mechanism works.
 */

async function loginAsSystemAdmin(page: Page) {
  await loginToApp(page, getSharedSession("system_admin"));
}

test.describe("System Admin Portal (Task #52)", () => {
  test("System Admin can view all three System Admin tabs", async ({ page }) => {
    await loginAsSystemAdmin(page);
    await page.goto("/app/system-admin");

    await expect(page.locator("h1")).toHaveText("System Admin");

    // SystemAdminPage.tsx's own tabs are plain <button>s with no
    // role="tab" — the original `[role='tab']` locator this file used
    // elsewhere never matched any of them.
    for (const label of ["Workflow Templates", "Roles & Access", "Configuration"]) {
      await expect(page.locator("button", { hasText: label })).toBeVisible();
    }

    // Workflow Templates is the default tab — all three known workflow
    // object keys always render a card, configured or not.
    for (const label of [
      "Leave & Attendance approval",
      "Recruitment requisition approval",
      "Payroll run approval",
    ]) {
      await expect(page.locator("h3", { hasText: label })).toBeVisible();
    }
  });

  test("System Admin can configure a workflow template", async ({ page }) => {
    await loginAsSystemAdmin(page);
    await page.goto("/app/system-admin");

    const card = page.locator("main .bg-card", { hasText: "Payroll run approval" });
    // Idempotent across re-runs against the same shared company within
    // this file's 10-minute session cache: once configured, "Configure"
    // no longer renders, so there's nothing further to assert here.
    const configureButton = card.locator("button", { hasText: "Configure" });
    if (!(await configureButton.isVisible())) {
      await expect(card.locator("text=Configured")).toBeVisible();
      return;
    }
    await configureButton.click();

    // TemplateForm defaults to one step with a role-approver already
    // pointed at hr_admin (`defaultRoleId`) — submitting with no changes
    // exercises the real create call with zero additional input.
    const form = card.locator("form");
    await expect(form).toBeVisible();
    await form.locator("button", { hasText: "Save" }).or(form.locator("button[type=submit]")).first().click();

    await expect(card.locator("text=Configured")).toBeVisible({ timeout: 5000 });
    await expect(card.locator("li")).toContainText("HR Admin");
  });

  test("Roles & Access lists this company's employees with their granted roles", async ({ page }) => {
    await loginAsSystemAdmin(page);
    await page.goto("/app/system-admin");

    await page.locator("button", { hasText: "Roles & Access" }).click();

    // RolesAccessPanel.tsx renders one card per employee, not a <table>
    // — the original `table tbody tr`/`.role-card` locators never
    // matched. These three employees are the ones global-setup.ts's own
    // `createRoleSession` calls provisioned under this shared company,
    // so they're always present and already hold the role they were
    // granted.
    // Two strict-mode traps here: (1) PortalLayout's own <aside> sidebar
    // also has class `bg-card` and shows the logged-in user's own name
    // ("E2E system admin") in its footer, so an unscoped `.bg-card`
    // locator matches both the sidebar and the real roster card —
    // scoping to `main` excludes the sidebar. (2) `text=` matching is
    // case-insensitive, so a loose `text=Line Manager` is a further trap:
    // it also matches the employee's own name div ("E2E line manager"),
    // not just the role chip <span> — scope to the chip element itself.
    const lineManagerRow = page.locator("main .bg-card", { hasText: "E2E line manager" });
    await expect(lineManagerRow).toBeVisible();
    await expect(lineManagerRow.locator("span", { hasText: "Line Manager" })).toBeVisible();

    const systemAdminRow = page.locator("main .bg-card", { hasText: "E2E system admin" });
    await expect(systemAdminRow).toBeVisible();
    await expect(systemAdminRow.locator("span", { hasText: "System Admin" })).toBeVisible();
  });

  test("Portal navigation includes System Admin menu item", async ({ page }) => {
    await loginAsSystemAdmin(page);
    await page.goto("/app");

    const systemAdminNavLink = page.locator("nav a").filter({ hasText: "System Admin" });
    await expect(systemAdminNavLink).toBeVisible();

    await systemAdminNavLink.click();
    await expect(page).toHaveURL(/\/app\/system-admin/);
  });
});

test.describe("System Admin Responsiveness", () => {
  test("Roles & Access is usable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await loginAsSystemAdmin(page);
    await page.goto("/app/system-admin");
    await page.locator("button", { hasText: "Roles & Access" }).click();

    await expect(page.locator("main .bg-card").first()).toBeVisible();

    const bodyWidth = await page.evaluate(() => document.body.offsetWidth);
    expect(bodyWidth).toBeLessThanOrEqual(375);
  });
});

test.describe("System Admin Accessibility", () => {
  test("Workflow template form inputs have properly associated labels", async ({ page }) => {
    await loginAsSystemAdmin(page);
    await page.goto("/app/system-admin");

    const card = page.locator("main .bg-card", { hasText: "Recruitment requisition approval" });
    const configureButton = card.locator("button", { hasText: "Configure" });
    if (!(await configureButton.isVisible())) {
      // Already configured by an earlier run against this shared
      // company — the gap below is a property of TemplateForm's JSX,
      // not of any particular template's data, so this test has nothing
      // further to usefully assert against this card specifically.
      test.skip();
    }
    await configureButton.click();

    const form = card.locator("form");
    await expect(form).toBeVisible();

    // Genuine, pre-existing accessibility gap — same pattern already
    // found and deliberately left failing in EmployeeCreatePage's,
    // LeaveRequestForm's, RequisitionForm's, and GroupForm's own e2e
    // specs: TemplateForm's "Workflow name" <label> has no `htmlFor`/
    // `id`, and its <input> has no `name` or `aria-label`. Left failing
    // on purpose so it keeps reporting the real gap.
    const nameInput = form.locator("input").first();
    const id = await nameInput.getAttribute("id");
    const hasAriaLabel = await nameInput.evaluate((el) => el.hasAttribute("aria-label"));
    const hasAssociatedLabel = id ? (await page.locator(`label[for="${id}"]`).count()) > 0 : false;

    expect(hasAssociatedLabel || hasAriaLabel).toBe(true);
  });
});
