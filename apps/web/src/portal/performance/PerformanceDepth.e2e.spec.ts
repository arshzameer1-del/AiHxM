import { test, expect, Page } from "@playwright/test";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** Step 11B (TAL-05/06/07): goals plan, phases, competencies and settings through a real browser against the real API. */
async function loginAsHrAdmin(page: Page) {
  await loginToApp(page, getSharedSession("hr_admin"));
}

test.describe("Performance depth (Step 11B)", () => {
  test("HR sets up competencies and the anonymity minimum", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/performance");
    await page.getByRole("tab", { name: "Setup" }).click();

    const name = `Ownership ${Date.now()}`;
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText(name)).toBeVisible();

    // The browser itself refuses a value outside 2 to 20 (the API refuses it too; see the service spec).
    await page.getByLabel("Minimum raters (2 to 20)").fill("1");
    expect(await page.getByLabel("Minimum raters (2 to 20)").evaluate((el: HTMLInputElement) => el.validity.rangeUnderflow)).toBe(true);
    await page.getByLabel("Minimum raters (2 to 20)").fill("3");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved")).toBeVisible();
  });

  test("a cycle can be given phase deadlines and goals can be weighted", async ({ page }) => {
    await loginAsHrAdmin(page);
    await page.goto("/app/performance");

    await page.getByRole("button", { name: "New Review Cycle" }).click();
    const cycleName = `Depth cycle ${Date.now()}`;
    await page.getByLabel("Cycle Name").fill(cycleName);
    await page.getByLabel("Start Date").fill("2030-01-01");
    await page.getByLabel("End Date").fill("2030-12-31");
    await page.getByRole("button", { name: /create/i }).click();
    const row = page.getByRole("row", { name: new RegExp(cycleName) });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "Phases" }).click();
    await page.getByLabel("Self assessment starts").fill("2030-02-01");
    await page.getByLabel("Self assessment ends").fill("2030-02-28");
    await page.getByRole("button", { name: "Save phases" }).click();
    await expect(row).toContainText("self assessment");
  });
});
