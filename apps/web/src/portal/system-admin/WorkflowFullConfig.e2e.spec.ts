import { test, expect, type Locator } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

async function openDetails(root: Locator, summaryText: string) {
  const details = root.locator("details").filter({ has: root.page().locator("summary", { hasText: summaryText }) }).first();
  if (!(await details.evaluate((e) => (e as HTMLDetailsElement).open))) await details.locator("summary").first().click();
  return details;
}

/**
 * BACKLOG58 - every process has a route on screen, every step option is reachable, "who would approve this?" answers without
 * sending anything, and earlier versions are listed.
 */
test.describe("Workflow configuration - all processes and step options", () => {
  test("every process is listed in plain words, grouped", async ({ page }) => {
    await loginToApp(page, getSharedSession("system_admin"));
    await page.goto("/app/system-admin");
    for (const group of ["Time and leave", "Pay", "Hiring and organisation", "Privacy"]) {
      await expect(page.getByRole("heading", { name: group, exact: true })).toBeVisible();
    }
    for (const label of [
      "Leave request approval", "Attendance correction approval", "Overtime claim approval", "On-duty request approval", "Timesheet approval",
      "Expense claim approval", "Loan approval", "Additional payment approval", "Off-cycle payment approval", "Payroll run approval",
      "Recruitment requisition approval", "Job offer approval", "Hiring approval", "New position approval", "Reorganization approval", "Data subject request approval",
    ]) {
      await expect(page.locator("h3", { hasText: label })).toBeVisible();
    }
  });

  test("a route with fallback, escalation, automatic decision and a step condition is saved, tested and kept in history", async ({ page }) => {
    await loginToApp(page, getSharedSession("system_admin"));
    await page.goto("/app/system-admin");

    const card = page.getByTestId("process-employee_loan");
    await expect(card.getByRole("button", { name: /^(Configure|Edit approvers)$/ })).toBeVisible();
    const configure = card.getByRole("button", { name: "Configure", exact: true });
    if (await configure.isVisible()) await configure.click();
    else await card.getByRole("button", { name: "Edit approvers" }).click();

    const form = card.locator("form").first();
    await form.getByLabel("Approver type").first().selectOption({ label: "The requester's manager" });
    await form.getByPlaceholder("SLA hours (optional)").first().fill("24");

    // when nobody is found / nobody answers
    await openDetails(form, "When nobody answers");
    await form.getByLabel("If nobody is found", { exact: true }).selectOption({ label: "Ask anyone holding a role" });
    await form.getByLabel("Escalate to", { exact: true }).selectOption({ label: "The approver's manager" });
    await form.getByLabel("Then decide automatically", { exact: true }).selectOption({ label: "Reject automatically" });
    await form.getByLabel("Hours after escalation").fill("12");

    // more options: reminders and a condition on the step
    await openDetails(form, "More options for this step");
    await form.getByLabel("Remind approvers every").fill("8");
    if ((await form.getByLabel("Condition field").count()) === 0) await form.getByRole("button", { name: "+ Add a rule" }).click();
    await form.getByLabel("Condition field").first().selectOption({ label: "Loan amount" });
    await form.getByLabel("Condition operator").first().selectOption({ label: "is at least" });
    await form.getByLabel("Condition value").first().fill("50000");

    await form.getByRole("button", { name: "Save changes" }).or(form.getByRole("button", { name: "Save workflow" })).click();
    const summary = card.getByTestId("route-employee_loan").locator("li").first();
    await expect(summary).toContainText("the requester's manager", { timeout: 8000 });
    await expect(summary).toContainText("SLA 24h");
    await expect(summary).toContainText("reminder every 8h");
    await expect(summary).toContainText("only when Loan amount is at least 50000");
    await expect(summary).toContainText("escalates to the approver's manager");
    await expect(summary).toContainText("rejected automatically 12h after escalation");

    // "who would approve this?": nothing is sent, the answer names the fallback because the test person has no manager
    const sim = card.getByTestId("simulate-employee_loan");
    await sim.locator("summary").click();
    const requester = sim.locator("select").first();
    const option = requester.locator("option", { hasText: "employee self service" }).first();
    await requester.selectOption((await option.getAttribute("value"))!);
    await sim.getByLabel("Loan amount").fill("80000");
    await sim.getByRole("button", { name: "Check" }).click();
    const result = sim.getByTestId("simulation-result");
    await expect(result).toContainText("Step 1");
    await expect(result).toContainText("fallback role");
    await sim.getByLabel("Loan amount").fill("100");
    await sim.getByRole("button", { name: "Check" }).click();
    await expect(sim.getByTestId("simulation-result")).toContainText("its condition does not match");

    // earlier versions are listed
    const history = card.getByTestId("history-employee_loan");
    await history.locator("summary").click();
    await expect(history).toContainText("Version 1");
  });

  test("a rule that makes no sense is explained instead of being saved", async ({ page }) => {
    await loginToApp(page, getSharedSession("system_admin"));
    await page.goto("/app/system-admin");
    const card = page.getByTestId("process-additional_payment");
    await expect(card.getByRole("button", { name: /^(Configure|Edit approvers)$/ })).toBeVisible();
    const configure = card.getByRole("button", { name: "Configure", exact: true });
    if (await configure.isVisible()) await configure.click();
    else await card.getByRole("button", { name: "Edit approvers" }).click();
    const form = card.locator("form").first();
    await form.getByLabel("Approver type").first().selectOption({ label: "Whoever holds a position" });
    await form.getByRole("button", { name: "Save changes" }).or(form.getByRole("button", { name: "Save workflow" })).click();
    await expect(form.getByRole("alert")).toContainText("choose a position");
    await form.getByRole("button", { name: "Cancel" }).click();
  });
});
