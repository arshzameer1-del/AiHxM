import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { API_BASE_URL, getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** HR adds a laptop and issues it; the employee confirms receipt on My Assets; HR takes it back. */
test.describe("Asset register", () => {
  test("add, issue, confirm, return", async ({ page, browser }) => {
    const tag = `E2E-${Date.now()}`;
    const hr = getSharedSession("hr_admin");
    const ess = getSharedSession("employee_self_service");
    const sub = JSON.parse(Buffer.from(ess.split(".")[1], "base64url").toString()).sub as string;
    const db = new Client({ connectionString: (process.env.DATABASE_URL ?? "").split("?")[0] });
    await db.connect();
    try {
      const emp = (await db.query("SELECT id, first_name, last_name FROM employees WHERE user_account_id = $1", [sub])).rows[0];
      expect(emp).toBeTruthy();

      await loginToApp(page, hr);
      await page.goto("/app/assets");
      await expect(page.getByRole("heading", { name: "Asset Register" })).toBeVisible();
      await page.getByRole("button", { name: "Add asset" }).click();
      const add = page.getByRole("form", { name: "Add an asset" });
      await add.getByLabel("Asset tag").fill(tag);
      await add.getByLabel("Name").fill("Dell Latitude 5440");
      await add.getByLabel("Purchase cost (PKR)").fill("185000");
      await add.getByRole("button", { name: "Add asset" }).click();
      await expect(page.getByText(`${tag} added to the register.`)).toBeVisible();

      const detail = page.getByTestId("asset-detail");
      await detail.getByRole("button", { name: "Issue to employee" }).click();
      const issue = page.getByRole("form", { name: "Issue to employee" });
      await issue.getByLabel("Employee").selectOption({ value: emp.id });
      await issue.getByLabel("Condition").selectOption("new");
      await issue.getByRole("button", { name: "Save" }).click();
      await expect(detail.getByText("Issued", { exact: true }).first()).toBeVisible();
      await expect(detail.getByText(`${emp.first_name} ${emp.last_name}`).first()).toBeVisible();

      // the employee sees it and confirms
      const mine = await browser.newPage();
      await loginToApp(mine, ess);
      await mine.goto("/app/ess/assets");
      const item = mine.getByRole("list", { name: "My assets" }).getByRole("listitem").filter({ hasText: tag });
      await expect(item).toBeVisible();
      await item.getByRole("button", { name: "I received this" }).click();
      await expect(item.getByText(/confirmed/)).toBeVisible();
      await mine.close();

      // HR sees the confirmation and takes it back damaged: it goes to maintenance
      await page.reload();
      await page.getByRole("button", { name: tag }).click();
      await expect(page.getByTestId("asset-detail").getByText("Receipt confirmed")).toBeVisible();
      await page.getByTestId("asset-detail").getByRole("button", { name: "Take back" }).click();
      const back = page.getByRole("form", { name: "Take back" });
      await back.getByLabel("Condition").selectOption("damaged");
      await back.getByRole("button", { name: "Save" }).click();
      await expect(page.getByTestId("asset-detail").getByText("In maintenance").first()).toBeVisible();

      const res = await fetch(`${API_BASE_URL}/asset-register/mine`, { headers: { Authorization: `Bearer ${ess}` } });
      expect(((await res.json()) as { assetTag: string }[]).some((a) => a.assetTag === tag)).toBe(false);
    } finally {
      await db.query("DELETE FROM employee_assets WHERE asset_tag = $1", [tag]);
      await db.query("DELETE FROM asset_events WHERE asset_id IN (SELECT id FROM asset_register WHERE asset_tag = $1)", [tag]);
      await db.query("DELETE FROM asset_register WHERE asset_tag = $1", [tag]);
      await db.end();
    }
  });
});
