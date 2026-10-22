import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/**
 * System Admin > Roles & Permissions: built-in roles are read only, the matrix shows every role, and a custom role can be
 * created and given the permissions the System Admin holds themselves.
 */
test.describe("Roles & Permissions", () => {
  test("built-in roles are read only and the matrix lists every role", async ({ page }) => {
    await loginToApp(page, getSharedSession("system_admin"));
    await page.goto("/app/system-admin?tab=permissions");

    await expect(page.getByRole("button", { name: /^HR Admin\s*\d+$/ })).toBeVisible();
    await page.getByRole("button", { name: /^HR Admin\s*\d+$/ }).click();
    await expect(page.getByText("Built-in role (read only)")).toBeVisible();
    const box = page.getByRole("checkbox", { name: "employee.view.all" });
    await expect(box).toBeChecked();
    await expect(box).toBeDisabled();

    await page.getByRole("button", { name: "Matrix" }).click();
    const table = page.locator("table");
    await expect(table.getByRole("columnheader", { name: "Line Manager" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Payroll Approver" })).toBeVisible();
    await expect(table.getByText("payroll.approve.all")).toBeVisible();
  });

  test("a System Admin creates a custom role with a permission they hold, and cannot tick one they do not hold", async ({ page }) => {
    await loginToApp(page, getSharedSession("system_admin"));
    await page.goto("/app/system-admin?tab=permissions");

    const name = `Workflow Helper ${Date.now() % 100000}`;
    await page.getByRole("button", { name: "New role" }).click();
    await page.getByLabel("Role name").fill(name);
    await page.getByRole("button", { name: "Create role" }).click();
    await expect(page.getByText("Custom role", { exact: true })).toBeVisible();

    // A System Admin does not hold employee.view.all, so its box is disabled.
    await expect(page.getByRole("checkbox", { name: "employee.view.all" })).toBeDisabled();
    const mine = page.getByRole("checkbox", { name: "workflow_template.manage.all" });
    await expect(mine).toBeEnabled();
    await mine.check();
    await page.getByRole("button", { name: "Save permissions" }).click();
    await expect(page.getByRole("status")).toContainText("Saved");

    await page.reload();
    await page.getByRole("button", { name: new RegExp(`^${name}\\s*1$`) }).click();
    await expect(page.getByRole("checkbox", { name: "workflow_template.manage.all" })).toBeChecked();

    // Switching it off.
    await page.getByRole("button", { name: "Switch off" }).click();
    await expect(page.getByRole("status")).toContainText("switched off");
  });
});
