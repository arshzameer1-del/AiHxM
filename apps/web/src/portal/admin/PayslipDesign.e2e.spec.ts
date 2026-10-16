import { expect, test } from "@playwright/test";
import { createHrAdminSession, createRoleSession, loginToApp } from "../../e2e-support/real-session";

/** Configuration Center > Payslip print design: HR Admin picks a layout, edits, sees the preview change, saves, and the design is kept. Real API. */
test.describe.configure({ mode: "serial" });
let hrToken = "";
let essToken = "";
test.beforeAll(async () => {
  const hr = await createHrAdminSession();
  hrToken = hr.token;
  essToken = await createRoleSession(hr, "employee_self_service");
});

test("HR Admin designs the payslip, previews it and saves", async ({ page }) => {
  await loginToApp(page, hrToken);
  await page.goto("/app/configuration-center");
  await page.getByRole("button", { name: /Payslip print design/ }).click();
  const screen = page.getByTestId("payslip-design");
  await expect(screen.getByRole("heading", { name: "Payslip print design" })).toBeVisible();

  const save = screen.getByRole("button", { name: "Save design" });
  await expect(save).toBeDisabled();
  const preview = screen.getByTestId("payslip-preview");
  await expect(preview).toContainText("Take home pay");
  await expect(preview).not.toContainText("in words");

  await screen.getByTestId("preset-modern").click();
  await expect(preview).toContainText("Take-home pay in words");
  await expect(preview).toContainText("One Lakh Sixty-Three Thousand");

  // A bad value blocks saving and says why.
  await screen.getByLabel("Margin (mm)").fill("99");
  await expect(screen.getByText("Must be a number from 5 to 30.")).toBeVisible();
  await expect(save).toBeDisabled();
  await screen.getByLabel("Margin (mm)").fill("12");

  await screen.getByLabel("Watermark text").fill("DRAFT");
  await expect(preview).toContainText("DRAFT");
  await screen.getByRole("button", { name: "Move Earnings down" }).click();
  await save.click();
  await expect(screen.getByRole("status")).toContainText("Saved");

  await page.reload();
  await expect(page.getByLabel("Watermark text")).toHaveValue("DRAFT");
  await expect(page.getByLabel("Margin (mm)")).toHaveValue("12");
  await expect(page.getByText(/Version 1/)).toBeVisible();

  await page.getByRole("button", { name: "Reset to built-in design" }).click();
  await expect(page.getByRole("status")).toContainText("built-in");
  await expect(page.getByLabel("Watermark text")).toHaveValue("");
});

test("an Employee has no Payslip print design card", async ({ page }) => {
  await loginToApp(page, essToken);
  await page.goto("/app/configuration-center");
  await expect(page.getByRole("button", { name: /Payslip print design/ })).toHaveCount(0);
});
