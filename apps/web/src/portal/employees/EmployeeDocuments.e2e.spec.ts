import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/**
 * BACKLOG50 - an employee uploads a document on My Profile, it waits for HR, HR approves it from the review inbox, and it
 * then shows as approved on the employee's own file.
 */
test.describe("Employee documents", () => {
  test("an employee's upload waits for HR and counts after approval", async ({ browser }) => {
    const fileName = `cnic-${Date.now()}.pdf`;

    const essContext = await browser.newContext();
    const ess = await essContext.newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));
    await ess.goto("/app/profile?tab=documents");
    await expect(ess.getByRole("heading", { name: "Upload a document for HR" })).toBeVisible();
    await ess.getByLabel("Document type").selectOption("cnic");
    await ess.getByLabel(/Expires on/).fill("2035-01-31");
    await ess.locator("#doc-file").setInputFiles({ name: fileName, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 e2e") });
    await ess.getByRole("button", { name: "Upload for HR to check" }).click();
    await expect(ess.getByText("Uploaded. HR will check it before it counts.")).toBeVisible();
    const row = ess.locator("[data-testid^=doc-]").filter({ hasText: fileName });
    await expect(row).toContainText("Waiting for HR");

    // a file that is not allowed is stopped before it is sent
    await ess.locator("#doc-file").setInputFiles({ name: "x.zip", mimeType: "application/zip", buffer: Buffer.from("zip") });
    await ess.getByRole("button", { name: "Upload for HR to check" }).click();
    await expect(ess.getByText(/Use a PDF, JPEG, PNG/)).toBeVisible();

    const hrContext = await browser.newContext();
    const hr = await hrContext.newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));
    await hr.goto("/app/employees/change-requests");
    const pending = hr.locator("[data-testid=pending-documents]");
    await expect(pending).toContainText(fileName);
    await pending.locator("div.bg-card").filter({ hasText: fileName }).getByRole("button", { name: "Approve" }).click();
    await expect(pending.getByText(fileName)).toHaveCount(0);

    await ess.reload();
    await ess.goto("/app/profile?tab=documents");
    const approved = ess.locator("[data-testid^=doc-]").filter({ hasText: fileName });
    await expect(approved).toBeVisible();
    await expect(approved).not.toContainText("Waiting for HR");

    await essContext.close();
    await hrContext.close();
  });
});
