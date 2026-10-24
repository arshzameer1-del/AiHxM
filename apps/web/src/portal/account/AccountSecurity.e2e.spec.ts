import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/**
 * BACKLOG51 - Account & security and the notification bell. Nothing here changes the shared test logins' passwords (that would
 * sign every other test out); the real password change is covered by the API tests.
 */
test.describe("Account & security", () => {
  test("the page shows my sign-in, validates the password form and offers the authenticator move", async ({ page }) => {
    await loginToApp(page, getSharedSession("employee_self_service"));
    await page.goto("/app/account");
    await expect(page.getByRole("heading", { name: "Account & security" })).toBeVisible();
    await expect(page.getByTestId("session-current")).toContainText("This device");

    await page.getByLabel("Current password").fill("whatever-it-is");
    await page.getByLabel("New password", { exact: true }).fill("short");
    await page.getByLabel("Type the new password again").fill("short");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "at least 10 characters" })).toBeVisible();

    await page.getByLabel("New password", { exact: true }).fill("a-long-enough-password-1");
    await page.getByLabel("Type the new password again").fill("a-long-enough-password-1");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "current password is not correct" })).toBeVisible();

    await page.getByRole("button", { name: /Move to a new phone|Set up an authenticator/ }).click();
    await expect(page.getByLabel("Your password")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByLabel("Your password")).toHaveCount(0);
  });

  test("notification settings can be changed and are remembered", async ({ page }) => {
    await loginToApp(page, getSharedSession("employee_self_service"));
    await page.goto("/app/account?tab=notifications");
    const box = page.getByLabel("Waiting for HR: in the app");
    const before = await box.isChecked();
    await box.click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Waiting for HR: in the app")).toBeChecked({ checked: !before });
    await page.getByLabel("Waiting for HR: in the app").click(); // put it back
    await expect(page.getByText("Saved.")).toBeVisible();
    // payslip notices are email only
    await expect(page.getByLabel("Payslip is ready: in the app")).toHaveCount(0);
    await expect(page.getByLabel("Payslip is ready: by email")).toBeVisible();
  });

  test("the bell tells HR about an upload and the employee about HR's decision", async ({ browser }) => {
    const fileName = `bell-${Date.now()}.pdf`;
    const essContext = await browser.newContext();
    const ess = await essContext.newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));
    const hrContext = await browser.newContext();
    const hr = await hrContext.newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));

    await ess.goto("/app/profile?tab=documents");
    await ess.getByLabel("Document type").selectOption("cnic");
    await ess.locator("#doc-file").setInputFiles({ name: fileName, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 bell") });
    await ess.getByRole("button", { name: "Upload for HR to check" }).click();
    await expect(ess.getByText("Uploaded. HR will check it before it counts.")).toBeVisible();

    await hr.goto("/app/");
    await hr.getByTestId("notification-bell").click();
    await expect(hr.getByTestId("notification-item").filter({ hasText: "A document is waiting for your review" }).first()).toBeVisible();
    await hr.getByTestId("notification-item").filter({ hasText: fileName }).first().click();
    await expect(hr).toHaveURL(/\/app\/employees\/change-requests/);
    const pending = hr.locator("[data-testid=pending-documents]");
    await pending.locator("div.bg-card").filter({ hasText: fileName }).getByRole("button", { name: "Approve" }).click();
    await expect(pending.getByText(fileName)).toHaveCount(0);

    await ess.goto("/app/");
    await ess.getByTestId("notification-bell").click();
    const item = ess.getByTestId("notification-item").filter({ hasText: fileName }).first();
    await expect(item).toContainText("HR approved your document");
    await item.click();
    await expect(ess).toHaveURL(/\/app\/profile\?tab=documents/);
    await essContext.close();
    await hrContext.close();
  });
});
