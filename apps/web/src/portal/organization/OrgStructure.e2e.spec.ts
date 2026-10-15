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

  // The old editing address now lands on this same page.
  await page.goto("/app/organization/manage");
  await expect(page).toHaveURL(/\/app\/organization$/);
  await expect(page.getByRole("treegrid", { name: "Staff assignments (structure)" })).toBeVisible();
});

test("the details pane follows the selected row (SAP style) and can be enlarged", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginToApp(page, hrToken);
  await page.goto("/app/organization");
  const grid = page.getByRole("treegrid", { name: "Staff assignments (structure)" });
  await page.getByRole("button", { name: "Show positions of every unit" }).click();
  await grid.locator("[data-key^='position:']").filter({ hasText: "President" }).first().click();

  const details = page.getByTestId("structure-details");
  await expect(details.getByRole("button", { name: /Details for Position President/ })).toBeVisible();
  for (const tab of ["Basic data", "Cost distribution", "Periods"]) await expect(details.getByRole("tab", { name: tab })).toBeVisible();
  await expect(details).toContainText("Head of own organizational unit");
  await expect(details).toContainText("Ahmed Aziz"); // holder table
  await details.getByRole("button", { name: /Increase detail area/ }).click();
  await expect(details.getByRole("button", { name: /Reduce detail area/ })).toBeVisible();
  await details.getByRole("tab", { name: "Periods" }).click();
  await expect(details.getByRole("tab", { name: "Periods" })).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: SHOTS ? `${SHOTS}/org-structure-details.png` : undefined, fullPage: true });
});

test("HR maintains the structure here: new sub-unit, move, archive/activate, assign and remove a holder", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginToApp(page, hrToken);
  await page.goto("/app/organization");
  const grid = page.getByRole("treegrid", { name: "Staff assignments (structure)" });
  const unitRow = (name: string) => grid.locator("[data-key^='unit:']").filter({ hasText: name }).first();
  const toolbar = page.getByRole("toolbar", { name: "Structure actions" });
  const panel = page.getByTestId("structure-panel");

  // New root unit.
  await toolbar.getByRole("button", { name: "New root unit" }).click();
  await panel.locator("#unit-name").fill("Field Ops");
  await panel.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("status")).toContainText("Field Ops");
  await expect(unitRow("Field Ops")).toBeVisible();

  // New sub-unit under the selected unit.
  await unitRow("Field Ops").click();
  await toolbar.getByRole("button", { name: "New sub-unit" }).click();
  await panel.locator("#unit-name").fill("Depot North");
  await panel.getByRole("button", { name: "Create" }).click();
  await expect(unitRow("Depot North")).toBeVisible();

  // Move the sub-unit under Marine Services.
  await unitRow("Depot North").click();
  await toolbar.getByRole("button", { name: "Move", exact: true }).click();
  await panel.locator("#move-target").selectOption({ label: "Marine Services" });
  await panel.getByRole("button", { name: "Move here" }).click();
  await expect(page.getByRole("status")).toContainText("moved");

  // Archive and activate again.
  await unitRow("Depot North").click();
  await toolbar.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("status")).toContainText("archived");
  await unitRow("Depot North").click();
  await toolbar.getByRole("button", { name: "Activate", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Activate" }).click();
  await expect(page.getByRole("status")).toContainText("activated");

  // Assign a holder to the vacant position, then remove them again.
  const beth = await api<{ id: string }>("/employees", "POST", { firstName: "Beth", lastName: "Holder", department: "Office", email: `org-struct-beth-${Date.now()}@example.com` });
  expect(beth.id).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: "Show positions of every unit" }).click();
  const advisor = grid.locator("[data-key^='position:']").filter({ hasText: "Financial Advisor" }).first();
  await expect(advisor).toContainText("Vacant");
  await advisor.click();
  await toolbar.getByRole("button", { name: "Assign holder" }).click();
  await panel.locator("#assign-search").fill("Beth");
  await panel.locator("#assign-employee").selectOption(beth.id);
  await panel.getByRole("button", { name: "Assign" }).click();
  await expect(page.getByRole("status")).toContainText("holder was assigned");
  await page.getByRole("button", { name: "Expand Financial Advisor" }).click(); // appears once the reload shows the new holder
  const bethRow = grid.locator("[data-key^='holder:']").filter({ hasText: "Beth Holder" });
  await expect(bethRow).toBeVisible();
  await bethRow.click();
  await toolbar.getByRole("button", { name: "Remove holder" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("status")).toContainText("was removed");
  await page.screenshot({ path: SHOTS ? `${SHOTS}/org-structure-maintained.png` : undefined, fullPage: true });
});

test("drag a unit onto another unit moves it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginToApp(page, hrToken);
  await page.goto("/app/organization");
  const grid = page.getByRole("treegrid", { name: "Staff assignments (structure)" });
  const unitRow = (name: string) => grid.locator("[data-key^='unit:']").filter({ hasText: name }).first();
  await page.getByRole("button", { name: "Expand all" }).click();
  await unitRow("Shared Services").dragTo(unitRow("Marine Services"));
  await expect(page.getByRole("status")).toContainText("moved under");
});

test("double-click opens the unit detail", async ({ page }) => {
  await loginToApp(page, hrToken);
  await page.goto("/app/organization");
  const grid = page.getByRole("treegrid", { name: "Staff assignments (structure)" });
  await expect(grid).toContainText("Marine Services");
  await grid.getByRole("row").filter({ hasText: "Marine Services" }).dblclick();
  await expect(page).toHaveURL(/\/app\/organization\/units\//);
});
