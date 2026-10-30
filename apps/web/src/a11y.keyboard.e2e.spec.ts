import { test, expect, type Page } from "@playwright/test";
import { getSharedSession, loginToApp, API_BASE_URL } from "./e2e-support/real-session";

/**
 * Keyboard and screen-reader behaviour of the Employees screens (axe cannot judge these): a person who never uses a mouse
 * must reach the main actions, always see where the focus is, and be kept inside and returned from a question dialog.
 */
async function me(token: string) {
  const res = await fetch(`${API_BASE_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()) as { employeeId: string };
}

const focusInside = (page: Page, selector: string) =>
  page.evaluate((s) => !!document.activeElement && !!document.activeElement.closest(s), selector);

test.describe("Keyboard and screen reader: Employees", () => {
  test("a confirmation dialog takes focus, keeps it, closes on Escape and gives the focus back", async ({ page }) => {
    const hrToken = getSharedSession("hr_admin");
    const target = await me(getSharedSession("employee_self_service"));
    await loginToApp(page, hrToken);
    await page.goto(`/app/employees/${target.employeeId}`);
    await page.getByRole("button", { name: "Family & Education" }).click();

    const lang = `Kbd${Date.now()}`;
    await page.getByLabel("Language", { exact: true }).fill(lang);
    await page.getByRole("button", { name: "Add language" }).click();
    const row = page.getByTestId("language-row").filter({ hasText: lang });
    await expect(row).toBeVisible();

    // open the question with the keyboard only
    const remove = row.getByRole("button", { name: "Remove" });
    await remove.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();

    // the dialog is named and described for a screen reader
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(await dialog.getAttribute("aria-describedby")).toBeTruthy();

    // focus moved into the dialog, and Tab / Shift+Tab cannot leave it
    await expect.poll(() => focusInside(page, '[role="alertdialog"]')).toBe(true);
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      expect(await focusInside(page, '[role="alertdialog"]'), `Tab ${i + 1} left the dialog`).toBe(true);
    }
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await focusInside(page, '[role="alertdialog"]'), `Shift+Tab ${i + 1} left the dialog`).toBe(true);
    }

    // Escape is the same as Cancel: nothing is removed, and the focus is back on the button that asked
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(1);
    await expect(remove).toBeFocused();

    // the safe choice is the one focus lands on, so Enter right away does not delete
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(1);

    // clean up through the keyboard too: open, move to the confirm button, activate
    await remove.focus();
    await page.keyboard.press("Enter");
    await dialog.getByRole("button", { name: "Remove" }).focus();
    await page.keyboard.press("Enter");
    await expect(row).toHaveCount(0);
  });

  test("the HR list is operable from the keyboard and always shows where the focus is", async ({ page }) => {
    await loginToApp(page, getSharedSession("hr_admin"));
    await page.goto("/app/employees");
    await expect(page.getByRole("table")).toBeVisible();

    // exactly one main landmark, one top-level heading, navigation present
    expect(await page.locator("main, [role=main]").count()).toBe(1);
    expect(await page.locator("h1").count()).toBe(1);
    expect(await page.locator("nav, [role=navigation]").count()).toBeGreaterThan(0);

    // the first 25 Tab stops each show a visible focus indicator (outline or ring) and have an accessible name
    const bad: string[] = [];
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
        const ring = cs.boxShadow !== "none" && cs.boxShadow !== "";
        const border = el.matches("input, select, textarea");
        const name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || (el as HTMLInputElement).placeholder || "").trim();
        const labelled = !!(el as HTMLInputElement).labels?.length || !!el.getAttribute("aria-labelledby");
        return { tag: el.tagName.toLowerCase(), text: name.slice(0, 40), visible: outline || ring || border, named: !!name || labelled };
      });
      if (!info) continue;
      if (!info.visible) bad.push(`stop ${i + 1} <${info.tag}> "${info.text}" shows no focus indicator`);
      if (!info.named) bad.push(`stop ${i + 1} <${info.tag}> has no accessible name`);
    }
    expect(bad, bad.join("\n")).toEqual([]);

    // an employee can be opened with the keyboard
    const first = page.getByRole("table").getByRole("link").first();
    await first.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/app\/employees\/[0-9a-f-]{36}/);
  });

  test("the section bars on the profile and the employee record say which section is open", async ({ page }) => {
    await loginToApp(page, getSharedSession("employee_self_service"));
    await page.goto("/app/profile");
    const bar = page.getByRole("button", { name: "Personal Information" });
    await expect(bar).toHaveAttribute("aria-current", "true");
    await page.getByRole("button", { name: "Contact", exact: true }).click();
    await expect(page.getByRole("button", { name: "Contact", exact: true })).toHaveAttribute("aria-current", "true");
    await expect(bar).not.toHaveAttribute("aria-current", "true");

    const target = await me(getSharedSession("employee_self_service"));
    await loginToApp(page, getSharedSession("hr_admin"));
    await page.goto(`/app/employees/${target.employeeId}`);
    await expect(page.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "true");
    await page.getByRole("button", { name: "Documents" }).click();
    await expect(page.getByRole("button", { name: "Documents" })).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("button", { name: "Overview" })).not.toHaveAttribute("aria-current", "true");
  });
});
