import { test, expect } from "@playwright/test";
import { API_BASE_URL, createCustomRoleSession, getSharedSession, loginToApp } from "../../e2e-support/real-session";

/**
 * BACKLOG56 - configuring workflows is a permission, not a job title. A person who holds a custom role with
 * "workflow_template.manage.all" (and nothing else from System Admin) can open System Admin, sees only Workflow Templates,
 * and can set approvers - including the custom role itself. The built-in HR Admin role does not hold that permission by default.
 */
test.describe("Workflow configuration by permission", () => {
  test("a custom role with the workflow permission configures workflows, and HR Admin without it cannot", async ({ page }) => {
    const hrToken = getSharedSession("hr_admin");
    const session = await createCustomRoleSession(hrToken, getSharedSession("system_admin"), ["workflow_template.manage.all"]);

    // the built-in HR Admin has no such permission by default: the server refuses
    const refused = await fetch(`${API_BASE_URL}/workflow/approver-options`, { headers: { Authorization: `Bearer ${hrToken}` } });
    expect(refused.status).toBe(403);
    const allowed = await fetch(`${API_BASE_URL}/workflow/approver-options`, { headers: { Authorization: `Bearer ${session.token}` } });
    expect(allowed.status).toBe(200);

    await loginToApp(page, session.token);
    await page.goto("/app/system-admin");
    await expect(page.locator("h1")).toHaveText("System Admin");
    await expect(page.locator("button", { hasText: "Workflow Templates" })).toBeVisible();
    for (const label of ["Roles & Access", "Roles & Permissions", "Configuration", "Appearance"]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    }

    const card = page.locator("main .bg-card", { hasText: "Payroll run approval" });
    await expect(card.locator("button", { hasText: /^(Configure|Edit approvers)$/ })).toBeVisible();
    const configure = card.getByRole("button", { name: "Configure", exact: true });
    if (await configure.isVisible()) {
      await configure.click();
      await card.locator("form button[type=submit]").first().click();
      await expect(card.locator("text=Configured")).toBeVisible({ timeout: 5000 });
    }

    await card.getByRole("button", { name: "Edit approvers" }).click();
    const form = card.locator("form");
    // the custom role the person holds is one of the roles a step can point at
    await expect(form.locator("option", { hasText: /E2E custom/ }).first()).toBeAttached();
    await form.getByPlaceholder("SLA hours (optional)").first().fill("48");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(card.locator("li").first()).toContainText("SLA 48h", { timeout: 5000 });
  });
});
