import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** Recognition feed, HR help desk and the compliance panels, through real screens. */
test.describe("Recognition, help desk and compliance", () => {
  test("help desk: employee asks, HR sees it in the queue and replies, employee sees the answer", async ({ browser }) => {
    const subject = `E2E question ${Date.now()}`;
    const hr = await (await browser.newContext()).newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));
    const ess = await (await browser.newContext()).newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));

    await ess.goto("/app/ess/helpdesk");
    await ess.getByLabel("Title").fill(subject);
    await ess.getByLabel("Your question").fill("When is the next payroll date?");
    await ess.getByRole("button", { name: "Send to HR" }).click();
    await expect(ess.getByTestId("hd-thread")).toContainText("When is the next payroll date?");

    await hr.goto("/app/employees/helpdesk");
    await expect(hr.getByTestId("hd-summary")).toBeVisible();
    await hr.getByTestId("hd-queue").getByRole("button", { name: new RegExp(subject) }).click();
    await hr.getByLabel("Reply", { exact: true }).fill("On the 28th.");
    await hr.getByRole("button", { name: "Send reply" }).click();
    await expect(hr.getByTestId("hd-thread")).toContainText("On the 28th.");

    await ess.goto("/app/ess/helpdesk");
    await ess.getByTestId("hd-mine").getByRole("button", { name: new RegExp(subject) }).click();
    await expect(ess.getByTestId("hd-thread")).toContainText("On the 28th.");
    await expect(ess.getByText("HR replied").first()).toBeVisible();

    await hr.goto("/app/employees/helpdesk");
    await hr.getByTestId("hd-queue").getByRole("button", { name: new RegExp(subject) }).click();
    await hr.getByRole("button", { name: "Resolve" }).click();
    await expect(hr.getByText("resolved").first()).toBeVisible();
  });

  test("recognition: an employee thanks a colleague, HR sees it on the feed and can hide it", async ({ browser }) => {
    const ess = await (await browser.newContext()).newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));
    const hr = await (await browser.newContext()).newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));
    const msg = `E2E thanks ${Date.now()}`;
    await ess.goto("/app/ess/recognition");
    await expect(ess.getByRole("heading", { name: "Recognition" })).toBeVisible();
    await ess.getByLabel("Who do you want to thank?").fill("line manager");
    const matches = ess.getByTestId("rec-matches");
    await expect(matches).toBeVisible();
    await matches.getByRole("button").first().click();
    await ess.getByLabel("What are you thanking them for?").fill(msg);
    await ess.getByRole("button", { name: "Send thank-you" }).click();
    await expect(ess.getByTestId("rec-feed")).toContainText(msg);

    await hr.goto("/app/ess/recognition");
    const item = hr.getByTestId("rec-item").filter({ hasText: msg });
    await expect(item).toContainText("thanked");
    await item.getByRole("button", { name: "Hide" }).click();
    await expect(hr.getByTestId("rec-item").filter({ hasText: msg })).toHaveCount(0);
  });

  test("compliance: minimum wage, levy worksheet and annual statement panels work", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    await page.goto("/app/payroll?tab=compliance");
    await expect(page.getByTestId("annual-statement-panel")).toBeVisible();
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect(page.getByText("finalised run").first()).toBeVisible();

    await page.getByRole("button", { name: /WWF and WPPF worksheets/ }).click();
    await page.getByLabel("Year", { exact: true }).fill("2099-00");
    await page.getByLabel("Base amount").fill("1000000");
    await page.getByLabel("Rate", { exact: true }).fill("2");
    await expect(page.getByText(/Works out to/)).toContainText("20,000");
    await page.getByRole("button", { name: "Save worksheet" }).click();
    const row = page.getByTestId("levy-row").filter({ hasText: "2099-00" });
    await expect(row).toContainText("20,000");
    await row.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("levy-row").filter({ hasText: "2099-00" })).toHaveCount(0);

    await page.getByRole("button", { name: /Minimum wage table/ }).click();
    await page.getByLabel("Province or area").fill("E2EProvince");
    await page.getByLabel("Monthly minimum").fill("12345");
    await page.getByLabel("Applies from").fill("2099-01-01");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const wage = page.getByTestId("minimum-wage-panel").getByRole("row").filter({ hasText: "E2EProvince" });
    await expect(wage).toContainText("12,345");
    await wage.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("minimum-wage-panel").getByText("E2EProvince")).toHaveCount(0);
  });
});
