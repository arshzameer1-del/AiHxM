import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** HR builds and opens an anonymous survey, an employee answers it once, HR sees that results stay hidden until five answered. */
test.describe("Surveys", () => {
  test("build from the template, open, answer, results hidden under five, close", async ({ browser }) => {
    const title = `E2E pulse ${Date.now()}`;
    const hr = await (await browser.newContext()).newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));
    const ess = await (await browser.newContext()).newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));

    await hr.goto("/app/employees/surveys");
    await hr.getByRole("button", { name: "New survey" }).click();
    await hr.locator("#sv-title").fill(title);
    await hr.getByRole("button", { name: "Start from an engagement template" }).click();
    await expect(hr.getByTestId("survey-question-row")).toHaveCount(5);
    await hr.getByRole("button", { name: "Open now" }).click();
    const card = hr.getByTestId("survey-admin-card").filter({ hasText: title });
    await expect(card).toContainText("Open");
    await expect(card).toContainText("Answered by 0 of");

    await ess.goto("/app/ess/surveys");
    const form = ess.getByTestId("survey-form").filter({ hasText: title });
    await expect(form).toContainText("Anonymous");
    // leaving a required question empty is refused before anything is sent
    await form.getByRole("button", { name: "Send my answers" }).click();
    await expect(ess.getByRole("alert")).toContainText("Please answer");
    await form.getByRole("radio", { name: "9", exact: true }).first().click();
    const ratings = form.getByRole("radiogroup");
    for (let i = 1; i <= 3; i++) await ratings.nth(i).getByRole("radio", { name: "4", exact: true }).click();
    await form.getByLabel("5. What is one thing we should change? (optional)").fill("Shorter meetings");
    await form.getByRole("button", { name: "Send my answers" }).click();
    await expect(ess.getByRole("status").filter({ hasText: "Thank you" })).toBeVisible();
    await expect(ess.getByTestId("survey-form").filter({ hasText: title })).toHaveCount(0);

    await hr.reload();
    const after = hr.getByTestId("survey-admin-card").filter({ hasText: title });
    await expect(after).toContainText("Answered by 1 of");
    await after.getByRole("button", { name: "Results" }).click();
    await expect(after.getByTestId("results-hidden")).toContainText("1 of the 5 answers needed");
    await expect(after.getByTestId("survey-comments")).toHaveCount(0);
    await expect(after.getByText("Shorter meetings")).toHaveCount(0);

    await after.getByRole("button", { name: "Close" }).click();
    await expect(hr.getByTestId("survey-admin-card").filter({ hasText: title })).toContainText("Closed");
  });
});
