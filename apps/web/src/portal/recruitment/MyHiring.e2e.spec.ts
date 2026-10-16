import { expect, test } from "@playwright/test";
import { createHrAdminSession, createRoleSession, loginToApp } from "../../e2e-support/real-session";

/** Parked B3: a Line Manager has a My Hiring page (not the HR Recruitment module); an Employee has neither. Real API. */
test.describe.configure({ mode: "serial" });
let managerToken = "";
let essToken = "";
test.beforeAll(async () => {
  const hr = await createHrAdminSession();
  managerToken = await createRoleSession(hr, "line_manager");
  essToken = await createRoleSession(hr, "employee_self_service");
});

test("a Line Manager reaches My Hiring from the menu and sees empty states; no Recruitment module link", async ({ page }) => {
  await loginToApp(page, managerToken);
  await page.goto("/app");
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("link", { name: "Recruitment", exact: true })).toHaveCount(0);
  await nav.getByRole("link", { name: "My Hiring", exact: true }).first().click();
  await expect(page).toHaveURL(/\/app\/my-hiring$/);
  await expect(page.getByRole("heading", { name: "My Hiring" })).toBeVisible();
  await expect(page.getByText("You are not named as hiring manager on any requisition.")).toBeVisible();
  await expect(page.getByText("You are not on any interview.")).toBeVisible();
});

test("an Employee has no My Hiring link", async ({ page }) => {
  await loginToApp(page, essToken);
  await page.goto("/app");
  await expect(page.getByRole("navigation").getByRole("link", { name: "My Hiring" })).toHaveCount(0);
});
