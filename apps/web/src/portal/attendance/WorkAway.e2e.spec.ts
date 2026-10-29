import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** Work from home: the employee asks on the Work-away page, the approver decides, the employee sees the answer. */
test.describe("Work-away requests", () => {
  test("an employee asks to work from home and the approver approves it", async ({ browser }) => {
    const stamp = Date.now();
    const day = new Date(Date.UTC(2031, 0, 1 + (stamp % 300)));
    const iso = day.toISOString().slice(0, 10);
    const essCtx = await browser.newContext();
    const ess = await essCtx.newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));
    const hrCtx = await browser.newContext();
    const hr = await hrCtx.newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));

    await ess.goto("/app/attendance");
    await ess.getByTestId("tile-work-away").click();
    await expect(ess.getByRole("heading", { name: "Work-away Requests" })).toBeVisible();
    await ess.getByRole("button", { name: "Request work-away" }).click();
    await expect(ess.getByRole("form", { name: "Work-away request form" })).toBeVisible();
    await ess.locator("#work-away-type").selectOption("work_from_home");
    await ess.locator("#work-away-start").fill(iso);
    await ess.locator("#work-away-end").fill(iso);
    await ess.locator("#work-away-location").fill(`Home ${stamp}`);
    await ess.locator("#work-away-reason").fill("Plumber visit");
    await ess.getByRole("button", { name: "Send request" }).click();
    const row = ess.getByTestId("work-away-row").filter({ hasText: `Home ${stamp}` });
    await expect(row).toContainText("Work from home");
    await expect(row).toContainText("Waiting");

    await hr.goto("/app/attendance/work-away-approvals");
    const card = hr.getByTestId("work-away-approval").filter({ hasText: `Home ${stamp}` });
    await expect(card).toContainText("Work from home");
    await card.getByRole("button", { name: "Approve" }).click();
    await card.getByRole("button", { name: /Confirm approval/ }).click();
    await expect(hr.getByTestId("work-away-approval").filter({ hasText: `Home ${stamp}` })).toHaveCount(0);

    // the app keeps answers for up to 15 s across a reload
    await ess.waitForTimeout(16000);
    await ess.reload();
    await expect(ess.getByTestId("work-away-row").filter({ hasText: `Home ${stamp}` })).toContainText("Approved");
  });
});
