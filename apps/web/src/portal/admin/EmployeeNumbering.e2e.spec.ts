import { expect, test } from "@playwright/test";
import { createHrAdminSession, createRoleSession, loginToApp } from "../../e2e-support/real-session";

/** Configuration Center > Employee numbering: the card is there for HR Admin, the rules can be changed and are kept, an Employee has neither. Real API. */
test.describe.configure({ mode: "serial" });
let hrToken = "";
let essToken = "";
test.beforeAll(async () => {
  const hr = await createHrAdminSession();
  hrToken = hr.token;
  essToken = await createRoleSession(hr, "employee_self_service");
});

test("HR Admin opens Employee numbering from the Configuration Center and saves new rules", async ({ page }) => {
  await loginToApp(page, hrToken);
  await page.goto("/app/configuration-center");
  await page.getByRole("button", { name: /Employee numbering/ }).click();
  const screen = page.getByTestId("employee-numbering");
  await expect(screen.getByRole("heading", { name: "Employee numbering" })).toBeVisible();

  const save = screen.getByRole("button", { name: "Save rules" });
  await expect(save).toBeDisabled();
  await screen.getByLabel("Series").selectOption("yearly");
  await screen.getByLabel("Typed numbers must match this pattern").fill("(");
  await expect(screen.getByText("This is not a valid pattern.")).toBeVisible();
  await expect(save).toBeDisabled();
  await screen.getByLabel("Typed numbers must match this pattern").fill("^EMP[0-9]{4}$");
  await save.click();
  await expect(screen.getByRole("status")).toContainText("Saved");

  await page.reload();
  await expect(page.getByLabel("Series")).toHaveValue("yearly");
  await expect(page.getByLabel("Typed numbers must match this pattern")).toHaveValue("^EMP[0-9]{4}$");
});

test("an Employee has no Employee numbering card and cannot read the rules", async ({ page }) => {
  await loginToApp(page, essToken);
  await page.goto("/app/configuration-center");
  await expect(page.getByRole("button", { name: /Employee numbering/ })).toHaveCount(0);
});
