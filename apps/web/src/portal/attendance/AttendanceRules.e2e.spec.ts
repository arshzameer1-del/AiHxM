import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

// a real 8x8 PNG so the browser can decode, scale and re-encode it as the selfie
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4YWODFTEMLQkAZZlQAVIPr1MAAAAASUVORK5CYII=", "base64");

/** HR sets an allowed place and a required selfie; an employee clocks in from elsewhere; HR reviews the clock-in and opens the selfie. */
test.describe("Attendance rules", () => {
  test("place, selfie, outside clock-in, review", async ({ browser }) => {
    const hr = await (await browser.newContext()).newPage();
    await loginToApp(hr, getSharedSession("hr_admin"));
    const ess = await (await browser.newContext({ geolocation: { latitude: 24.8607, longitude: 67.0011 }, permissions: ["geolocation"] })).newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));
    const db = new Client({ connectionString: (process.env.DATABASE_URL ?? "").split("?")[0] });
    await db.connect();

    try {
      await hr.goto("/app/attendance/rules");
      await hr.getByRole("button", { name: "Add a place" }).click();
      await hr.locator("#gf-name").fill("Head Office");
      await hr.locator("#gf-lat").fill("31.5204");
      await hr.locator("#gf-lng").fill("74.3587");
      await hr.getByRole("button", { name: "Save place" }).click();
      await expect(hr.getByTestId("geofence-row")).toContainText("Head Office");
      await hr.locator("#ar-geo").selectOption("flag");
      await expect(hr.getByText("Saved")).toBeVisible();
      await hr.locator("#ar-selfie").selectOption("required");
      await expect(hr.getByText("Saved")).toBeVisible();

      await ess.goto("/app/attendance/clock");
      await expect(ess.getByTestId("selfie-step")).toContainText("required");
      await expect(ess.getByTestId("location-step")).toBeVisible();
      await ess.getByTestId("clock-in-button").click();
      await expect(ess.getByText(/selfie is required/i)).toBeVisible();
      await ess.locator("#clock-selfie").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
      await expect(ess.getByAltText("Your selfie")).toBeVisible();
      await ess.getByTestId("clock-in-button").click();
      await expect(ess.getByTestId("clock-in-time")).toContainText("In at");

      await hr.getByRole("tab", { name: "Review clock-ins" }).click();
      const row = hr.getByTestId("exception-row").first();
      await expect(row).toContainText("Outside allowed places");
      await row.getByRole("button", { name: "Selfie" }).click();
      await expect(hr.getByTestId("selfie-view").getByRole("img")).toBeVisible();
    } finally {
      // leave the shared company as we found it: checks off, no places, and no clock-in left for today
      const co = (await db.query("SELECT company_id FROM attendance_geofences WHERE name = 'Head Office' ORDER BY created_at DESC LIMIT 1")).rows[0]?.company_id;
      if (co) {
        await db.query("DELETE FROM attendance_records WHERE company_id = $1 AND geofence_result <> 'not_applicable'", [co]);
        await db.query("DELETE FROM attendance_policy_settings WHERE company_id = $1", [co]);
        await db.query("DELETE FROM attendance_geofences WHERE company_id = $1", [co]);
      }
      await db.end();
    }
  });
});
