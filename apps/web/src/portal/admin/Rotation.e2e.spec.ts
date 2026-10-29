import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { API_BASE_URL, getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** HR sets up a rotating schedule that alternates a morning and an evening shift, then removes it. */
test.describe("Rotating shifts", () => {
  test("set up and remove a rotation", async ({ page }) => {
    const stamp = Date.now();
    const token = getSharedSession("hr_admin");
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const mk = async (name: string, scheduleType: string, startTime = "09:00", endTime = "17:00") =>
      (await (await fetch(`${API_BASE_URL}/shifts`, { method: "POST", headers: auth, body: JSON.stringify({ name, startTime, endTime, scheduleType }) })).json()) as { id: string };
    const names = { rota: `Rota ${stamp}`, am: `Morning ${stamp}`, pm: `Evening ${stamp}` };
    await mk(names.am, "fixed", "06:00", "14:00");
    await mk(names.pm, "fixed", "14:00", "22:00");
    const rota = await mk(names.rota, "rotating");
    const db = new Client({ connectionString: (process.env.DATABASE_URL ?? "").split("?")[0] });
    await db.connect();
    try {
      await loginToApp(page, token);
      await page.goto("/app/admin");
      await page.locator("button", { hasText: "Shifts & Work Schedule" }).click();
      const form = page.getByRole("form", { name: `Rotation for ${names.rota}` });
      await expect(form).toBeVisible();
      await form.getByLabel("Week 1 starts on").fill("2026-01-05");
      await form.getByLabel("Week 1", { exact: true }).selectOption({ label: names.am });
      await form.getByLabel("Week 2", { exact: true }).selectOption({ label: names.pm });
      await form.getByRole("button", { name: "Save rotation" }).click();
      await expect(form.getByText("Rotation saved.")).toBeVisible();

      const view = await (await fetch(`${API_BASE_URL}/shifts/${rota.id}/rotation`, { headers: auth })).json();
      expect(view.weeks.map((w: { memberShiftName: string }) => w.memberShiftName)).toEqual([names.am, names.pm]);

      await form.getByRole("button", { name: "Remove rotation" }).click();
      await expect(form.getByText("Rotation removed.")).toBeVisible();
    } finally {
      await db.query("DELETE FROM shifts WHERE name = ANY($1)", [Object.values(names)]);
      await db.end();
    }
  });
});
