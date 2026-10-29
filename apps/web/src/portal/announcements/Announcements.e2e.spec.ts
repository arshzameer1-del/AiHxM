import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** HR publishes a notice, an employee reads and confirms it, HR sees who has read it. The notice is withdrawn at the end. */
test.describe("Announcements", () => {
  test("publish, read, confirm, see readers, withdraw", async ({ browser }) => {
    const stamp = Date.now();
    const title = `Office closed Monday ${stamp}`;
    const hr = await (await browser.newContext()).newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));
    const ess = await (await browser.newContext()).newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));

    await hr.goto("/app/employees/announcements");
    await hr.getByRole("button", { name: "New announcement" }).click();
    await hr.locator("#ann-title").fill(title);
    await hr.locator("#ann-body").fill("The office is closed on Monday for maintenance.");
    await hr.getByLabel("Ask people to confirm they read it").check();
    // SMS and WhatsApp stay switched off until a provider is connected
    await expect(hr.locator("label", { hasText: "SMS" }).locator("input")).toBeDisabled();
    await hr.getByRole("button", { name: "Publish now" }).click();
    const card = hr.getByTestId("announcement-admin-card").filter({ hasText: title });
    await expect(card).toContainText("Published");
    await expect(card).toContainText("Read by 0 of");

    await ess.goto("/app/ess/announcements");
    const mine = ess.getByTestId("announcement-card").filter({ hasText: title });
    await expect(mine).toContainText("New");
    await mine.getByRole("button").first().click();
    await expect(mine).toContainText("closed on Monday");
    await mine.getByRole("button", { name: "I have read this" }).click();
    await expect(mine).toContainText("You confirmed");

    await hr.reload();
    const after = hr.getByTestId("announcement-admin-card").filter({ hasText: title });
    await expect(after).toContainText("confirmed by 1");
    await after.getByRole("button", { name: "Who has read it" }).click();
    await expect(after.getByTestId("receipts")).toContainText("Confirmed");

    await after.getByRole("button", { name: "Withdraw" }).click();
    await expect(hr.getByTestId("announcement-admin-card").filter({ hasText: title })).toContainText("Archived");
    await ess.reload();
    await expect(ess.getByTestId("announcement-card").filter({ hasText: title })).toHaveCount(0);
  });
});
