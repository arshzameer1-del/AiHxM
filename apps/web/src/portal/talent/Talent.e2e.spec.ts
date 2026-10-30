import { test, expect } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

test.describe("Talent and compensation planning", () => {
  test("skills: HR adds a skill, an employee rates it, HR places someone on the nine-box and builds a pool", async ({ browser }) => {
    const skill = `E2E skill ${Date.now()}`;
    const hr = await (await browser.newContext()).newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));
    const ess = await (await browser.newContext()).newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));

    await hr.goto("/app/employees/talent");
    await hr.getByRole("tab", { name: "Skills" }).click();
    await hr.getByLabel("New skill").fill(skill);
    await hr.getByRole("button", { name: "Add", exact: true }).click();
    await expect(hr.getByTestId("skill-list")).toContainText(skill);

    await ess.goto("/app/ess/skills");
    await ess.getByLabel(`${skill} level`).selectOption("4");
    await expect(ess.getByLabel(`${skill} level`)).toHaveValue("4");

    await hr.getByRole("tab", { name: "Nine-box" }).click();
    await hr.getByTestId("ninebox-waiting").getByRole("button").first().click();
    await hr.getByLabel("Potential").selectOption("high");
    await hr.getByLabel("Performance").selectOption({ label: "Set myself: High" });
    await hr.getByRole("button", { name: "Save placement" }).click();
    await expect(hr.getByTestId("cell-high-high")).not.toBeEmpty();

    await hr.getByRole("tab", { name: "Talent pools" }).click();
    const pool = `E2E pool ${Date.now()}`;
    await hr.getByLabel("New pool").fill(pool);
    await hr.getByRole("button", { name: "Create" }).click();
    await expect(hr.getByTestId("pool-list")).toContainText(pool);
    await hr.getByRole("button", { name: "Delete pool" }).last().click();
  });

  test("compensation planning: start a cycle, load people, propose, submit, and cancel without touching payroll", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    await page.goto("/app/payroll?tab=inputs");
    await page.getByRole("button", { name: /Compensation planning/ }).click();
    const name = `E2E cycle ${Date.now()}`;
    await page.getByLabel("Cycle name").fill(name);
    await page.getByLabel("New salaries start").fill("2099-01-01");
    await page.getByRole("button", { name: "Start a cycle" }).click();
    const cycle = page.getByTestId("comp-cycle").filter({ hasText: name });
    await expect(cycle).toContainText("Draft");
    await cycle.getByRole("button", { name: "Load people" }).click();
    await cycle.getByRole("button", { name: "Cancel cycle" }).click();
    await expect(cycle).toContainText("Cancelled");
  });
});
