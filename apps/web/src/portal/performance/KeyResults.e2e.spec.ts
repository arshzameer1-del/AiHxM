import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { API_BASE_URL, getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** An employee breaks a goal into key results, checks in, and sees the goal move; the alignment tab lists it. */
test.describe("OKR key results", () => {
  test("add, check in, alignment", async ({ page }) => {
    const stamp = Date.now();
    const cycleName = `E2E OKR ${stamp}`;
    const goalTitle = `E2E goal ${stamp}`;
    const hr = getSharedSession("hr_admin");
    const ess = getSharedSession("employee_self_service");
    const sub = JSON.parse(Buffer.from(ess.split(".")[1], "base64url").toString()).sub as string;
    const db = new Client({ connectionString: (process.env.DATABASE_URL ?? "").split("?")[0] });
    await db.connect();
    const call = async (token: string, path: string, body: unknown) => {
      const res = await fetch(`${API_BASE_URL}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(res.ok, `${path} ${res.status}`).toBe(true);
      return (await res.json()) as { id?: string; cycle?: { id: string } };
    };
    try {
      const emp = (await db.query("SELECT id FROM employees WHERE user_account_id = $1", [sub])).rows[0];
      const cycle = await call(hr, "/review-cycles", { name: cycleName, periodStart: "2026-01-01", periodEnd: "2026-12-31" });
      await call(hr, `/review-cycles/${cycle.id}/launch`, {});
      await call(ess, "/goals", { reviewCycleId: cycle.id, employeeId: emp.id, title: goalTitle });

      await loginToApp(page, ess);
      await page.goto("/app/performance");
      await page.getByRole("tab", { name: "Goals" }).click();
      await page.getByLabel("Review cycle").selectOption({ label: `${cycleName} (active)` });
      const row = page.getByRole("row", { name: new RegExp(goalTitle) });
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: /^Key results/ }).click();

      const panel = page.getByRole("region", { name: `Key results for ${goalTitle}` });
      await panel.getByRole("button", { name: "Add a key result" }).click();
      const form = panel.getByRole("form", { name: "New key result" });
      await form.getByLabel("Key result").fill("Close ten bugs");
      await form.getByLabel("Target").fill("10");
      await form.getByLabel("Unit").fill("bugs");
      await form.getByRole("button", { name: "Add key result" }).click();
      await expect(panel.getByText("Close ten bugs")).toBeVisible();

      await panel.getByRole("button", { name: "Check in" }).click();
      const ci = panel.getByRole("form", { name: "Check in on Close ten bugs" });
      await ci.getByLabel(/Current value/).fill("4");
      await ci.getByRole("button", { name: "Save check-in" }).click();
      await expect(panel.getByText("Goal progress follows these key results: 40%.")).toBeVisible();
      await expect(row.getByRole("button", { name: "Key results (1)" })).toBeVisible();
      await expect(row.getByText("In Progress", { exact: false }).first()).toBeVisible();

      // the plain progress edit is closed off, with a pointer to the key results
      await row.getByRole("button", { name: "Update" }).click();
      await expect(page.getByText("Progress follows this goal's key results.")).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).last().click();

      await page.getByRole("tab", { name: "Alignment" }).click();
      const tree = page.getByLabel("Goal alignment");
      await expect(tree.getByText(goalTitle)).toBeVisible();
      await expect(tree.getByText("1 key result")).toBeVisible();
    } finally {
      await db.query("DELETE FROM goals WHERE title = $1", [goalTitle]);
      await db.query("DELETE FROM review_cycles WHERE name = $1", [cycleName]);
      await db.end();
    }
  });
});
