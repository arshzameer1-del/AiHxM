import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** Documents to sign, API keys and quick answers, through real screens. */
test.describe("Documents to sign, developer keys, quick answers", () => {
  test("HR sends a document, the employee signs by typing their name, HR sees it signed", async ({ browser }) => {
    const title = `E2E policy ${Date.now()}`;
    const hr = await (await browser.newContext()).newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));
    const ess = await (await browser.newContext()).newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));

    await hr.goto("/app/employees/esign");
    await expect(hr.getByTestId("esign-admin")).toBeVisible();
    await hr.getByLabel("Title").fill(title);
    await hr.getByLabel("Text to read and agree to").fill("I have read and will follow the E2E conduct policy.");
    await hr.getByRole("checkbox", { name: /E2E employee self service/ }).check();
    await hr.getByRole("button", { name: /^Send to 1 person/ }).click();
    await expect(hr.getByTestId("esign-table")).toContainText(title);

    await ess.goto("/app/ess/sign");
    const item = ess.getByTestId("sign-item").filter({ hasText: title });
    await expect(item).toBeVisible();
    const sign = item.getByRole("button", { name: "Sign", exact: true });
    await expect(sign).toBeDisabled();
    await item.getByLabel("Type your full name to say you have read this and agree").fill("E2E employee self service");
    await sign.click();
    await expect(ess.getByTestId("sign-item").filter({ hasText: title })).toContainText("Signed as E2E employee self service");

    await hr.goto("/app/employees/esign");
    await expect(hr.getByTestId("esign-table").locator("tr", { hasText: title })).toContainText(/signed/i);
  });

  test("developer: an API key is shown once and can be revoked", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    await page.goto("/app/employees/developer");
    await expect(page.getByTestId("developer")).toBeVisible();
    await page.getByLabel("What will use this key?").fill(`E2E key ${Date.now()}`);
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Create key" }).click();
    const shown = page.getByTestId("new-key");
    await expect(shown).toContainText("shown only once");
    await page.getByRole("button", { name: "I have saved it" }).click();
    await expect(page.getByTestId("new-key")).toHaveCount(0);
    await expect(page.getByTestId("key-table")).toBeVisible();
    await page.getByTestId("key-table").getByRole("button", { name: /Revoke/ }).first().click();
    await expect(page.getByTestId("key-table")).toContainText("Revoked");
  });

  test("quick answers: a question about leave gets an answer from the person's own records", async ({ page }) => {
    await loginToApp(page, getSharedSession("employee_self_service"));
    await page.goto("/app/ess/assistant");
    await page.getByLabel("Your question").fill("how many leave days do I have");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(page.getByTestId("qa-log")).not.toBeEmpty();
    await expect(page.getByTestId("qa-log")).toContainText("how many leave days do I have");
  });
});
