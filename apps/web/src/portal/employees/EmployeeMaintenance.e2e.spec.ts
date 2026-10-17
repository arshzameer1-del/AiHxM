import { test, expect, Page } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/**
 * Employee maintenance vs Hire (2026-10).
 *
 * "Employees" is for the people already hired (directory, records, personal details, lifecycle). Hiring - the guided
 * wizard, quick add, bulk hiring - is its own section at /app/hire. These tests pin that split and walk the maintenance
 * screens: open an employee, change personal details, see them kept.
 */

async function loginAsHrAdmin(page: Page) {
  await loginToApp(page, getSharedSession("hr_admin"));
}

/** Hires one person through Quick Add and returns the employee page address. */
async function quickHire(page: Page, last: string): Promise<string> {
  await page.goto("/app/hire/quick");
  await page.getByLabel("First name", { exact: true }).fill("Maintain");
  await page.getByLabel("Last name", { exact: true }).fill(last);
  await page.getByLabel("Email", { exact: true }).fill(`${last.toLowerCase()}@example.com`);
  await page.getByRole("button", { name: /create employee/i }).click();
  await expect(page).toHaveURL(/\/app\/employees\/[a-f0-9-]+$/, { timeout: 15000 });
  return new URL(page.url()).pathname;
}

test.describe("Employees and Hire are separate", () => {
  test("the Employees page offers no hiring buttons", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/employees");
    await expect(page.locator("h1")).toContainText(/employees/i);
    // The page itself (not the sidebar) has no hiring buttons.
    const content = page.locator("main");
    await expect(content.getByRole("link", { name: "Guided Hire" })).toHaveCount(0);
    await expect(content.getByRole("link", { name: "New Employee" })).toHaveCount(0);
  });

  test("the sidebar has an Employees group and a separate Hire group", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/employees");
    const nav = page.locator("nav");
    // Employees group: directory and analytics only.
    await expect(nav.getByRole("link", { name: "Directory" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Workforce Analytics" })).toBeVisible();
    // Hire group: the three ways of hiring.
    await expect(nav.getByRole("link", { name: "Guided Hire" })).toHaveAttribute("href", "/app/hire");
    await expect(nav.getByRole("link", { name: "Quick Add" })).toHaveAttribute("href", "/app/hire/quick");
    await expect(nav.getByRole("link", { name: "Bulk Hiring" })).toHaveAttribute("href", "/app/hire/bulk");
    // And none of them lives under /app/employees any more.
    await expect(nav.locator('a[href^="/app/employees/hire"], a[href="/app/employees/new"], a[href="/app/employees/bulk-import"]')).toHaveCount(0);
  });

  test("the hiring screens open under /app/hire", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/hire");
    await expect(page.getByRole("heading", { name: /hire an employee/i })).toBeVisible();
    await page.goto("/app/hire/quick");
    await expect(page.getByRole("heading", { name: "New Employee" })).toBeVisible();
    await page.goto("/app/hire/bulk");
    await expect(page.locator("h1").first()).toBeVisible();
  });

  test("old /app/employees hiring addresses redirect to the Hire section", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/employees/hire");
    await expect(page).toHaveURL(/\/app\/hire$/);
    await page.goto("/app/employees/new");
    await expect(page).toHaveURL(/\/app\/hire\/quick$/);
    await page.goto("/app/employees/bulk-import");
    await expect(page).toHaveURL(/\/app\/hire\/bulk$/);
  });
});

test.describe("Employee maintenance", () => {
  test("HR opens an employee and edits the Overview fields", async ({ page }) => {
    await loginAsHrAdmin(page);
    await quickHire(page, `Overview${Date.now()}`);
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Designation").fill("Analyst");
    await page.getByLabel("Department").fill("Finance");
    await page.getByRole("button", { name: /save/i }).click();
    await expect(page.getByText("Analyst")).toBeVisible();
    await expect(page.getByText("Finance")).toBeVisible();
  });

  test("HR maintains the personal details of a hired employee", async ({ page }) => {
    await loginAsHrAdmin(page);
    const url = await quickHire(page, `Personal${Date.now()}`);

    await page.getByRole("button", { name: "Personal Details" }).click();
    await expect(page.getByTestId("person-details")).toBeVisible();
    await page.getByTestId("person-edit").click();
    await expect(page.getByTestId("person-edit-form")).toBeVisible();

    await page.getByLabel("Middle name").fill("Ahmed");
    await page.getByLabel("Known as").fill("Mo");
    await page.getByLabel("Title").fill("Mr");
    await page.getByLabel("Place of birth").fill("Lahore");
    await page.getByLabel("Nationality", { exact: true }).selectOption({ label: "Pakistani" });
    await page.getByLabel("Passport number").fill("AB1234567");
    await page.getByLabel("NTN").fill("1234567-8");
    await page.getByLabel("Reason (optional)").fill("Completed from hire documents");
    await page.getByTestId("person-save").click();

    // Back to the read view with the new values.
    await expect(page.getByTestId("person-edit-form")).toHaveCount(0);
    await expect(page.getByTestId("pd-middleName")).toHaveText("Ahmed");
    await expect(page.getByTestId("pd-preferredName")).toHaveText("Mo");
    await expect(page.getByTestId("pd-placeOfBirth")).toHaveText("Lahore");
    await expect(page.getByTestId("pd-nationality")).toHaveText("Pakistani");
    // ID numbers stay masked until asked for.
    await expect(page.getByTestId("pd-passportNumber")).not.toContainText("AB1234567");
    await page.getByRole("button", { name: /show passport number/i }).click();
    await expect(page.getByTestId("pd-passportNumber")).toContainText("AB1234567");

    // Kept after a reload.
    await page.goto(url);
    await page.getByRole("button", { name: "Personal Details" }).click();
    await expect(page.getByTestId("pd-middleName")).toHaveText("Ahmed");

    // A change dated in the future is kept as its own slice of the history and does not replace today's record.
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    await page.getByTestId("person-edit").click();
    await page.getByLabel("Known as").fill("Mohammad");
    await page.getByLabel("Takes effect on (optional)").fill(future);
    await page.getByTestId("person-save").click();
    await expect(page.getByTestId("person-edit-form")).toHaveCount(0);
    await expect(page.getByTestId("pd-slice-select")).toBeVisible();
    await expect(page.getByTestId("pd-preferredName")).toHaveText("Mo");
    await expect(page.getByTestId("pd-slice-select").locator("option")).toHaveCount(2);
    const upcoming = await page.getByTestId("pd-slice-select").locator("option", { hasText: "upcoming" }).getAttribute("value");
    await page.getByTestId("pd-slice-select").selectOption(upcoming!);
    await expect(page.getByTestId("pd-slice-title")).toBeVisible();
    await expect(page.getByTestId("pd-preferredName")).toHaveText("Mohammad");
  });

  test("personal details can be emptied again and cancel keeps the record as it was", async ({ page }) => {
    await loginAsHrAdmin(page);
    await quickHire(page, `Clear${Date.now()}`);
    await page.getByRole("button", { name: "Personal Details" }).click();

    await page.getByTestId("person-edit").click();
    await page.getByLabel("Place of birth").fill("Karachi");
    await page.getByTestId("person-save").click();
    await expect(page.getByTestId("pd-placeOfBirth")).toHaveText("Karachi");

    await page.getByTestId("person-edit").click();
    await page.getByLabel("Place of birth").fill("Islamabad");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("pd-placeOfBirth")).toHaveText("Karachi");

    await page.getByTestId("person-edit").click();
    await page.getByLabel("Place of birth").fill("");
    await page.getByTestId("person-save").click();
    await expect(page.getByTestId("pd-placeOfBirth")).toHaveText("—");
  });
});
