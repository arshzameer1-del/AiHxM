import { expect, test } from "@playwright/test";
import { API_BASE_URL, createHrAdminSession, loginToApp } from "../../e2e-support/real-session";

/**
 * "Staff assignments (structure)": the organization hierarchy as a tree-table (unit > positions > holders), against
 * the real API. One company with a root unit, a sub-unit, a chief position with a holder, and an ordinary position.
 */

const SHOTS = process.env.ORG_SHOTS_DIR;
let hrToken = "";

async function api<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${hrToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

test.beforeAll(async () => {
  hrToken = (await createHrAdminSession()).token;
  const root = await api<{ id: string }>("/organization/units", "POST", { name: "Marine Services", unitType: "business_unit", code: "AMS" });
  const office = await api<{ id: string }>("/organization/units", "POST", { name: "President Office", unitType: "division", code: "PRES", parentId: root.id });
  await api("/organization/units", "POST", { name: "Shared Services", unitType: "department", code: "SHARED", parentId: office.id });
  await api<{ id: string }>("/organization/positions", "POST", { orgUnitId: office.id, positionTitle: "Financial Advisor", positionCode: "FIN" });
  const president = await api<{ id: string }>("/organization/positions", "POST", { orgUnitId: office.id, positionTitle: "President", positionCode: "PRESIDENT" });
  await api(`/organization/units/${office.id}/head-position`, "POST", { positionId: president.id });
  const ahmed = await api<{ id: string }>("/employees", "POST", { firstName: "Ahmed", lastName: "Aziz", department: "Office", email: `org-struct-${Date.now()}@example.com` });
  await api(`/organization/positions/${president.id}/assign`, "POST", { employeeId: ahmed.id });
});

test("tree-table shows units, positions and holders with chief and validity; expand, collapse, find", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await loginToApp(page, hrToken);
  await page.goto("/app/organization");

  const grid = page.getByRole("treegrid", { name: "Staff assignments (structure)" });
  await expect(grid).toBeVisible();
  for (const h of ["Code", "ID", "Relationship text", "Chief", "Valid from", "Valid to"]) {
    await expect(grid.getByRole("columnheader", { name: h, exact: true })).toBeVisible();
  }

  const rootRow = grid.getByRole("row").filter({ hasText: "Marine Services" });
  await expect(rootRow).toContainText("AMS");
  await expect(rootRow).toContainText(/O 00|[0-9A-F]{8}/);
  await expect(rootRow).toContainText("Unlimited");

  // Open every unit: sub-unit, chief position first, then the other position, with the holder under the chief position.
  await page.getByRole("button", { name: "Show positions of every unit" }).click();
  const rows = grid.getByRole("row");
  const officeRow = rows.filter({ hasText: "President Office" });
  await expect(officeRow).toContainText("Is line supervisor of");
  await expect(officeRow).toContainText("Ahmed Aziz"); // chief
  const positionRows = grid.locator("[data-key^='position:']");
  await expect(positionRows).toHaveCount(2);
  await expect(positionRows.first()).toContainText("President"); // chief position is listed first
  await expect(positionRows.first()).toContainText("Incorporates");
  await expect(positionRows.nth(1)).toContainText("Financial Advisor");
  await page.getByRole("button", { name: "Expand all" }).click(); // holders sit under their position
  const holderRow = grid.locator("[data-key^='holder:']");
  await expect(holderRow).toHaveCount(1);
  await expect(holderRow).toContainText("Ahmed Aziz");
  await expect(holderRow).toContainText("Holder");
  await expect(grid).toContainText("Shared Services");
  await page.screenshot({ path: SHOTS ? `${SHOTS}/org-structure-expanded.png` : undefined, fullPage: true });

  // Collapse all leaves just the root; expand it again with its toggle.
  await page.getByRole("button", { name: "Collapse all" }).click();
  await expect(grid).not.toContainText("President Office");
  await page.getByRole("button", { name: "Expand Marine Services" }).click();
  await expect(grid).toContainText("President Office");

  // Select a row (amber) and find.
  await rows.filter({ hasText: "President Office" }).first().click();
  await expect(rows.filter({ hasText: "President Office" }).first()).toHaveAttribute("aria-selected", "true");
  await page.locator("#structure-find").fill("Financial");
  await expect(grid).toContainText("Financial Advisor");
  await expect(grid).not.toContainText("Shared Services");
  await page.locator("#structure-find").fill("");

  // Editing page is still reachable for HR.
  await page.getByRole("link", { name: /Edit structure/ }).click();
  await expect(page).toHaveURL(/\/app\/organization\/manage/);
});

test("double-click opens the unit detail", async ({ page }) => {
  await loginToApp(page, hrToken);
  await page.goto("/app/organization");
  const grid = page.getByRole("treegrid", { name: "Staff assignments (structure)" });
  await expect(grid).toContainText("Marine Services");
  await grid.getByRole("row").filter({ hasText: "Marine Services" }).dblclick();
  await expect(page).toHaveURL(/\/app\/organization\/units\//);
});
