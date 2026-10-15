import { test, expect, Page } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/**
 * Step 11A (TAL-01..04): the recruitment depth screens through a real browser against the real API - duplicate detection,
 * a candidate profile, and the Interviews / Checks / Offers / Events / Settings tabs.
 */
async function loginAsHrAdmin(page: Page) {
  await loginToApp(page, getSharedSession("hr_admin"));
}

test.describe("Recruitment depth (Step 11A)", () => {
  test("duplicate candidates are flagged and the profile opens", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/recruitment");
    await page.getByRole("button", { name: "Candidates", exact: true }).click();

    const suffix = Date.now();
    const email = `dup-${suffix}@example.com`;
    async function addCandidate(lastName: string) {
      await page.getByRole("button", { name: "Add Candidate", exact: true }).click();
      const form = page.locator("form");
      await form.locator("label", { hasText: "First name" }).locator("+ input").fill("Dana");
      await form.locator("label", { hasText: "Last name" }).locator("+ input").fill(lastName);
      await form.locator("label", { hasText: "Email (optional)" }).locator("+ input").fill(email);
      await form.getByRole("button", { name: "Add candidate" }).click();
    }

    await addCandidate(`First ${suffix}`);
    await expect(page.getByText(`Dana First ${suffix}`)).toBeVisible();

    await addCandidate(`Second ${suffix}`);
    await expect(page.getByRole("alert")).toContainText("already in the pool");
    await page.getByRole("button", { name: /add anyway/i }).click();
    await expect(page.getByText(`Dana Second ${suffix}`)).toBeVisible();

    await page.getByRole("button", { name: "Open profile" }).first().click();
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(page.getByText("Back to the pool")).toBeVisible();
  });

  test("the new tabs render their real empty states", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/recruitment");

    await page.getByRole("button", { name: "Interviews", exact: true }).click();
    await expect(page.getByRole("button", { name: "Schedule interview" })).toBeVisible();

    await page.getByRole("button", { name: "Checks", exact: true }).click();
    await expect(page.getByLabel("Application")).toBeVisible();

    await page.getByRole("button", { name: "Offers", exact: true }).click();
    await expect(page.getByRole("button", { name: "New offer" })).toBeVisible();

    await page.getByRole("button", { name: "Events", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Next 30 days" })).toBeVisible();
    await page.getByRole("button", { name: "New event" }).click();
    const eventTitle = `Campus drive ${Date.now()}`;
    await page.getByLabel("Title").fill(eventTitle);
    await page.getByLabel("Starts").fill("2030-03-01T10:00");
    await page.getByRole("button", { name: "Create event" }).click();
    await expect(page.getByText(eventTitle)).toBeVisible();
  });

  test("settings start empty and save", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/recruitment");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Keep candidate data for (months)").fill("18");
    await page.getByLabel("Offers stay valid for (days)").fill("7");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Saved")).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByLabel("Keep candidate data for (months)")).toHaveValue("18");
  });
});
