import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** Two people paid into one account are flagged; HR marks it as fine with a reason, then brings it back. */
test.describe("Smart checks", () => {
  test("flag, mark as fine, check again", async ({ page }) => {
    const stamp = Date.now();
    const bidx = `e2e-bidx-${stamp}`;
    const hr = getSharedSession("hr_admin");
    const ess = getSharedSession("employee_self_service");
    const sub = JSON.parse(Buffer.from(ess.split(".")[1], "base64url").toString()).sub as string;
    const db = new Client({ connectionString: (process.env.DATABASE_URL ?? "").split("?")[0] });
    await db.connect();
    const numbers = [`SC${stamp}A`, `SC${stamp}B`];
    try {
      const companyId = (await db.query("SELECT company_id FROM employees WHERE user_account_id = $1", [sub])).rows[0].company_id as string;
      for (const n of numbers) {
        const id = (await db.query(
          "INSERT INTO employees (company_id, employee_number, first_name, last_name, date_of_joining) VALUES ($1,$2,'Smart','Check','2024-01-01') RETURNING id",
          [companyId, n]
        )).rows[0].id as string;
        await db.query(
          "INSERT INTO employee_payment_accounts (company_id, employee_id, payment_method, account_number_bidx, status, approval_status) VALUES ($1,$2,'bank_transfer',$3,'active','approved')",
          [companyId, id, bidx]
        );
      }

      await loginToApp(page, hr);
      await page.goto("/app/employees/smart-checks");
      await expect(page.getByRole("heading", { name: "Smart Checks" })).toBeVisible();
      const card = page.getByRole("region", { name: "Two or more people paid into the same bank account" });
      await expect(card.getByText(numbers[0]!, { exact: false })).toBeVisible();
      await expect(card.getByText(/Same account number on 2 active employees/)).toBeVisible();

      await card.getByRole("button", { name: "Looked, it's fine" }).first().click();
      await card.getByLabel("Why is it fine?").fill("Spouses sharing a joint account");
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card.getByText("Clear")).toBeVisible();

      await page.getByRole("button", { name: /findings marked as fine/ }).click();
      await expect(page.getByText("Spouses sharing a joint account")).toBeVisible();
      await page.getByRole("button", { name: "Check again" }).first().click();
      await expect(card.getByText(/1 to look at/)).toBeVisible();
    } finally {
      await db.query("DELETE FROM smart_check_dismissals WHERE subject_key = $1", [bidx]);
      await db.query("DELETE FROM employee_payment_accounts WHERE account_number_bidx = $1", [bidx]);
      await db.query("DELETE FROM employees WHERE employee_number = ANY($1)", [numbers]);
      await db.end();
    }
  });
});
