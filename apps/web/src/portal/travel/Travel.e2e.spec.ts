import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { API_BASE_URL, getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** An employee asks to travel with an advance; HR approves, pays the advance and settles the trip from the company's rates. */
test.describe("Business travel", () => {
  test("ask, approve, advance, settle", async ({ page, browser }) => {
    const dest = `Karachi ${Date.now()}`;
    const hr = getSharedSession("hr_admin");
    const ess = getSharedSession("employee_self_service");
    const hrAuth = { Authorization: `Bearer ${hr}`, "Content-Type": "application/json" };
    const sub = JSON.parse(Buffer.from(ess.split(".")[1], "base64url").toString()).sub as string;
    const db = new Client({ connectionString: (process.env.DATABASE_URL ?? "").split("?")[0] });
    await db.connect();
    const rates: string[] = [];
    try {
      const mk = async (name: string, rateKind: string, amount: number) => {
        const r = await fetch(`${API_BASE_URL}/travel/rates`, { method: "POST", headers: hrAuth, body: JSON.stringify({ name, rateKind, tripType: "domestic", amount }) });
        expect(r.ok).toBe(true);
        rates.push(((await r.json()) as { id: string }).id);
      };
      const stamp = Date.now();
      await mk(`E2E per diem ${stamp}`, "per_diem", 6000);
      await mk(`E2E mileage ${stamp}`, "mileage", 40);

      const mine = await browser.newPage();
      await loginToApp(mine, ess);
      await mine.goto("/app/travel");
      await mine.getByRole("button", { name: "Ask to travel" }).click();
      const form = mine.getByRole("form", { name: "Ask to travel" });
      const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
      await form.getByLabel("Destination").fill(dest);
      await form.getByLabel("From").fill(day(5));
      await form.getByLabel("To").fill(day(7));
      await form.getByLabel("Advance you would like (PKR)").fill("20000");
      await form.getByLabel("What is the trip for?").fill("Client workshop");
      await form.getByRole("button", { name: "Send request" }).click();
      await expect(mine.getByText(`Your request to travel to ${dest} was sent.`)).toBeVisible();
      await mine.close();

      await loginToApp(page, hr);
      await page.goto("/app/travel");
      await page.getByRole("tab", { name: "Approvals" }).click();
      const pending = page.getByRole("list", { name: "Waiting for approval" }).getByTestId("trip").filter({ hasText: dest });
      await expect(pending).toBeVisible();
      await pending.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(pending).toHaveCount(0);

      await page.getByRole("tab", { name: "All trips and rates" }).click();
      const trip = page.getByRole("list", { name: "All trips" }).getByTestId("trip").filter({ hasText: dest });
      await trip.getByRole("button", { name: "Pay advance" }).click();
      await trip.getByRole("button", { name: "Queue for payroll" }).click();
      await expect(page.getByText(`Advance for ${dest} queued for the next payroll.`)).toBeVisible();

      // the trip is now in the past so it can be settled
      await db.query("UPDATE travel_requests SET start_date = CURRENT_DATE - 3, end_date = CURRENT_DATE - 1 WHERE destination = $1", [dest]);
      await page.reload();
      await page.getByRole("tab", { name: "All trips and rates" }).click();
      const again = page.getByRole("list", { name: "All trips" }).getByTestId("trip").filter({ hasText: dest });
      await again.getByRole("button", { name: "Settle" }).click();
      const settle = again.getByRole("form", { name: "Settle trip" });
      await settle.getByLabel("Days travelled").fill("3");
      await settle.getByLabel("Distance (km)").fill("200");
      await settle.getByLabel("Other costs (PKR)").fill("4000");
      await settle.getByRole("button", { name: "Work out the balance" }).click();
      await expect(settle.getByTestId("settlement-balance")).toContainText("PKR 10,000 to pay the employee"); // 18000 + 8000 + 4000 - 20000 advance
      await settle.getByRole("button", { name: "Settle and send to payroll" }).click();
      await expect(page.getByText(/settled: PKR 10,000 to pay the employee/)).toBeVisible();

      const emp = (await db.query("SELECT id FROM employees WHERE user_account_id = $1", [sub])).rows[0].id;
      const pay = await db.query("SELECT payment_type, amount FROM employee_additional_payments WHERE employee_id = $1 AND label LIKE $2 ORDER BY created_at", [emp, `Travel %: ${dest}`]);
      expect(pay.rows.map((p) => `${p.payment_type}:${Number(p.amount)}`)).toEqual(["earning:20000", "earning:10000"]);
    } finally {
      await db.query("DELETE FROM employee_additional_payments WHERE label LIKE $1", [`Travel %: ${dest}`]);
      await db.query("DELETE FROM travel_requests WHERE destination = $1", [dest]);
      await db.query("DELETE FROM travel_rates WHERE id = ANY($1::uuid[])", [rates]);
      await db.end();
    }
  });
});
