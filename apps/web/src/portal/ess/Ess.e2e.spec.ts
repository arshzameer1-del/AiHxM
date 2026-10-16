import { expect, test } from "@playwright/test";
import { createHrAdminSession, createRoleSession, loginToApp } from "../../e2e-support/real-session";

/**
 * The "Employee Self Service" role: its own home is a launchpad of tiles. Tiles with a real page open it, the rest are
 * greyed "Coming soon", and no tile appears twice. Against the real API.
 */

const SHOTS = process.env.ESS_SHOTS_DIR;
test.describe.configure({ mode: "serial" }); // one setup (login throttle: 10/min per IP)

let essToken = "";
let hrToken = "";

test.beforeAll(async () => {
  const hr = await createHrAdminSession();
  hrToken = hr.token;
  essToken = await createRoleSession(hr, "ess_portal");
});

test("home shows the Employee (HCM) tiles once each; unavailable ones are greyed, not links", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginToApp(page, essToken);
  await page.goto("/app");

  const pad = page.getByTestId("ess-launchpad");
  await expect(pad).toBeVisible();
  await expect(pad.getByText("Employee (HCM)")).toBeVisible();

  for (const title of ["My Paystubs", "My Time Events", "My Leave Requests", "My Profile", "My Personal Data", "My Bank Details", "My Communication Data", "My Internal Data", "My Timesheet"]) {
    await expect(pad.getByRole("link", { name: new RegExp(title) })).toHaveCount(1);
  }
  // Merged away: these would only repeat another tile.
  for (const gone of ["My Profile Enhance", "My Leave Requests Enhance", "My Benefits Enrollment", "My Time Statements", "My Team Calendar"]) {
    await expect(pad.getByText(gone, { exact: true })).toHaveCount(0);
  }
  // Coming soon: shown, flagged, and not clickable.
  for (const title of ["Employee Lookup", "My Benefits", "My Addresses", "My Family Members", "My Medical Information", "My Forms"]) {
    const tile = pad.getByRole("group", { name: new RegExp(title) });
    await expect(tile).toHaveCount(1);
    await expect(tile).toContainText("Coming soon");
    await expect(pad.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);
  }
  await page.screenshot({ path: SHOTS ? `${SHOTS}/ess-home.png` : undefined, fullPage: true });
});

test("the sidebar has Employee Self Service and a tile opens the matching page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginToApp(page, essToken);
  await page.goto("/app");
  await page.getByRole("navigation").getByRole("link", { name: "Employee Self Service" }).click();
  await expect(page).toHaveURL(/\/app\/ess$/);
  await expect(page.getByRole("heading", { name: "Employee Self Service" })).toBeVisible();

  await page.getByTestId("ess-launchpad").getByRole("link", { name: /My Bank Details/ }).click();
  await expect(page).toHaveURL(/\/app\/profile\?tab=contact/);
  await expect(page.getByText("Bank account", { exact: true })).toBeVisible(); // the Contact tab is open
});

test("the role label shows and the user keeps own-data access (profile, leave) but no HR admin pages", async ({ page }) => {
  await loginToApp(page, essToken);
  await page.goto("/app");
  await expect(page.getByText("Employee Self Service").first()).toBeVisible();
  await page.goto("/app/leave/my-requests");
  await expect(page.getByRole("heading", { name: /leave/i }).first()).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Admin Center" })).toHaveCount(0);
});

test("HR can give the role to an employee, and other roles keep their normal home", async ({ page }) => {
  await loginToApp(page, hrToken);
  await page.goto("/app");
  await expect(page.getByTestId("ess-launchpad")).toHaveCount(0);
  await expect(page.getByRole("navigation").getByRole("link", { name: "Employee Self Service" })).toHaveCount(0);
});
