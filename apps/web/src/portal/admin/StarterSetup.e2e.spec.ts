import { expect, test } from "@playwright/test";
import { createHrAdminSession, createRoleSession, loginToApp } from "../../e2e-support/real-session";

/** A new company's first day: the Configuration Center offers the starter setup, applying it fills the gaps, an employee never sees it. Real API. */
test.describe.configure({ mode: "serial" });
let hrToken = "";
let essToken = "";
test.beforeAll(async () => {
  const hr = await createHrAdminSession();
  hrToken = hr.token;
  essToken = await createRoleSession(hr, "employee_self_service");
});

test("HR Admin sees what is missing, adds it, and everything reads as in place", async ({ page }) => {
  await loginToApp(page, hrToken);
  await page.goto("/app/configuration-center");
  const panel = page.getByTestId("starter-setup");
  await expect(panel.getByRole("heading", { name: "Starter setup" })).toBeVisible();
  await expect(panel.getByText("Leave request approval")).toBeVisible();
  await expect(panel.getByText("Missing").first()).toBeVisible();

  await panel.getByRole("button", { name: "Add the missing items" }).click();
  await expect(panel.getByRole("status")).toContainText("Added");
  await expect(panel.getByRole("button", { name: "Add the missing items" })).toHaveCount(0);
  await expect(panel.getByText("Missing")).toHaveCount(0);
  // Nothing is pretended: with nobody holding Payroll Approver, payroll still says so.
  await expect(panel.getByText("Needs a decision")).toBeVisible();
});

test("an Employee does not see the starter setup", async ({ page }) => {
  await loginToApp(page, essToken);
  await page.goto("/app/configuration-center");
  await expect(page.getByTestId("starter-setup")).toHaveCount(0);
});

test("HR Admin sees a nudge on Home that leads to the starter setup; an Employee does not", async ({ page, browser }) => {
  await loginToApp(page, hrToken);
  await page.goto("/app");
  const nudge = page.getByTestId("starter-setup-nudge");
  await expect(nudge).toContainText("Finish setting up your company");
  await nudge.getByRole("link", { name: /Open Starter setup/ }).click();
  await expect(page.getByTestId("starter-setup")).toBeVisible();

  const other = await browser.newPage();
  await loginToApp(other, essToken);
  await other.goto("/app");
  await expect(other.getByRole("heading", { name: /Good to see you/ }).or(other.getByRole("region", { name: "My workspace" }))).toBeVisible();
  await expect(other.getByTestId("starter-setup-nudge")).toHaveCount(0);
  await other.close();
});
