import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/**
 * Form designer: HR builds the Employee form without code. Creates their own field, groups the form into sections,
 * publishes, and the employee edit form follows; the value saves with the employee. Everything is put back afterwards.
 */
const API = "http://localhost:4000";
const stamp = Date.now().toString(36);
const LABEL = `Medical insurance no ${stamp}`;

test.describe("Form designer", () => {
  test.afterEach(async ({ request }) => {
    const headers = { Authorization: `Bearer ${getSharedSession("hr_admin")}` };
    await request.delete(`${API}/form-layouts/employee_profile`, { headers });
    await request.delete(`${API}/form-layouts/employee_profile/draft`, { headers });
    const defs = await request.get(`${API}/custom-fields/definitions?objectKey=employee`, { headers });
    if (defs.ok()) {
      for (const d of (await defs.json()) as Array<{ fieldKey: string; label: string }>) {
        if (d.label.endsWith(stamp)) await request.delete(`${API}/custom-fields/definitions/employee/${d.fieldKey}`, { headers });
      }
    }
  });

  test("HR adds a field of their own, groups the form into sections, publishes, and the employee form follows", async ({ page }) => {
    test.setTimeout(120000);
    await loginToApp(page, getSharedSession("hr_admin"));
    await page.goto("/app/configuration-center/form-designer?form=employee_profile");
    const designer = page.getByTestId("form-designer");
    await expect(designer).toBeVisible();
    await expect(page.getByTestId("fd-status")).toContainText("Not published yet");

    await page.getByLabel("Field name").fill(LABEL);
    await page.getByRole("button", { name: /Create field and add it to the form/ }).click();
    await expect(page.getByRole("status")).toBeVisible();

    // The designer opens with the suggested sections; the new field is in, nothing is live yet.
    await expect(page.getByTestId("fd-status")).toContainText("Unsaved changes");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByTestId("fd-status")).toContainText("Live, version");

    // The employee page follows the published layout, including the new field.
    await page.goto("/app/hire/quick");
    await page.getByLabel("First name", { exact: true }).fill("Designed");
    await page.getByLabel("Last name", { exact: true }).fill(`Form${stamp}`);
    await page.getByLabel("Email", { exact: true }).fill(`designed${stamp}@example.com`);
    await page.getByRole("button", { name: /create employee/i }).click();
    await expect(page).toHaveURL(/\/app\/employees\/[a-f0-9-]+$/, { timeout: 15000 });
    await page.getByRole("button", { name: "Edit" }).first().click();
    await expect(page.getByText("Personal information").first()).toBeVisible();
    const custom = page.getByLabel(LABEL);
    await expect(custom).toBeVisible();
    await custom.fill("MI-12345");
    await page.getByRole("button", { name: /^Save/ }).first().click();
    await expect(page.getByTestId("employee-custom-fields")).toContainText("MI-12345", { timeout: 15000 });

    // Back to the default for everyone.
    await page.goto("/app/configuration-center/form-designer?form=employee_profile");
    await page.getByRole("button", { name: "Reset to default" }).click();
    await page.getByRole("button", { name: /^(Yes|Reset|Put it back|Confirm)/ }).first().click();
    await expect(page.getByTestId("fd-status")).toContainText("Not published yet", { timeout: 15000 });
  });

  test("a form whose layout cannot be designed yet says so and still offers its field settings", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    await page.goto("/app/configuration-center/form-designer?form=leave_request");
    await expect(page.getByText(/cannot be designed yet/)).toBeVisible();
    await expect(page.getByTestId("fd-settings-only")).toBeVisible();
  });
});
