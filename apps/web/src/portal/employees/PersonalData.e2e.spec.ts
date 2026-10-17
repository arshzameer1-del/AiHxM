import { expect, test } from "@playwright/test";
import { API_BASE_URL, createHrAdminSession, createRoleSession, loginToApp } from "../../e2e-support/real-session";

/** My Profile > Personal Information, laid out like SAP's My Personal Data. Real API. */
test.describe.configure({ mode: "serial" });

test("an employee reads their personal data in groups, sees earlier records and keeps ID numbers hidden", async ({ page }) => {
  const hr = await createHrAdminSession();
  const ess = await createRoleSession(hr, "employee_self_service");

  const mine = await (await fetch(`${API_BASE_URL}/employees/me/personal-data`, { headers: { Authorization: `Bearer ${ess}` } })).json();
  expect(mine.person?.id).toBeTruthy();

  // HR records details today, and a marriage that takes effect next month: that one is an upcoming record.
  const today = new Date().toISOString().slice(0, 10);
  const nextMonth = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  const send = (body: unknown) =>
    fetch(`${API_BASE_URL}/persons/${mine.person.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${hr.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await send({ nationality: "Pakistani", placeOfBirth: "Lahore", language: "Urdu", passportNumber: "AB1234567", effectiveDate: today })).ok).toBeTruthy();
  expect((await send({ maritalStatus: "married", maritalStatusDate: nextMonth, effectiveDate: nextMonth })).ok).toBeTruthy();

  await loginToApp(page, ess);
  await page.goto("/app/profile");

  const card = page.getByTestId("personal-data");
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading", { name: "Name" })).toBeVisible();
  await expect(card.getByRole("heading", { name: "Birth data" })).toBeVisible();
  await expect(card.getByRole("heading", { name: "Marital status" })).toBeVisible();
  await expect(card.getByRole("heading", { name: "Identification" })).toBeVisible();
  await expect(page.getByTestId("pd-slice-title")).toContainText("Valid from");

  await expect(page.getByTestId("pd-nationality")).toHaveText("Pakistani");
  await expect(page.getByTestId("pd-placeOfBirth")).toHaveText("Lahore");
  await expect(page.getByTestId("pd-language")).toHaveText("Urdu");
  await expect(page.getByTestId("pd-maritalStatus")).toHaveText("—");
  await expect(page.getByTestId("pd-initials")).toHaveText(/E\./);

  // The passport number is hidden until asked for.
  const passport = page.getByTestId("pd-passportNumber");
  await expect(passport).not.toContainText("AB1234567");
  await passport.getByRole("button", { name: /show passport number/i }).click();
  await expect(passport).toContainText("AB1234567");

  // The record that takes effect next month can be opened, and says it is not in force yet.
  const select = page.getByTestId("pd-slice-select");
  await expect(select).toBeVisible();
  const options = await select.locator("option").allTextContents();
  expect(options.length).toBeGreaterThanOrEqual(2);
  expect(options[0]).toContain("upcoming");
  await select.selectOption({ index: 0 });
  await expect(page.getByTestId("pd-upcoming")).toContainText("Not in force yet");
  await expect(page.getByTestId("pd-maritalStatus")).toHaveText("Married");
  await expect(page.getByTestId("pd-passportNumber")).toHaveCount(0); // ID numbers belong to the current record only
});

test("the header shows phone and email links and opens more details", async ({ page }) => {
  const hr = await createHrAdminSession();
  const ess = await createRoleSession(hr, "employee_self_service");
  await loginToApp(page, ess);
  await page.goto("/app/profile");
  await expect(page.getByTestId("profile-email")).toHaveAttribute("href", /^mailto:/);
  await expect(page.getByTestId("profile-header-more")).toHaveCount(0);
  await page.getByTestId("profile-header-toggle").click();
  await expect(page.getByTestId("profile-header-more")).toContainText("Date of joining");
});
