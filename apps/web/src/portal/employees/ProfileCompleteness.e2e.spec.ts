import { test, expect } from "@playwright/test";
import { API_BASE_URL, getSharedSession, loginToApp } from "../../e2e-support/real-session";

async function api(token: string, path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${API_BASE_URL}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** BACKLOG53 - completeness score and what is missing, the work profile, out-of-office cover. */
test.describe("Profile completeness, work profile and cover", () => {
  test("the employee sees what is missing, HR sets a work profile, and the score moves when data is added", async ({ browser }) => {
    const essToken = getSharedSession("employee_self_service");
    const hrToken = getSharedSession("hr_admin");
    const me = (await api(essToken, "/auth/me")) as { employeeId: string };

    const essCtx = await browser.newContext();
    const ess = await essCtx.newPage();
    await loginToApp(ess, essToken);
    await ess.goto("/app/profile");
    const card = ess.getByTestId("completeness-card");
    await expect(card).toBeVisible();
    // the shared e2e tenant keeps state between runs: only expect the gap while it is still open
    const start = (await api(essToken, "/employees/me/completeness")) as { items: Array<{ key: string; done: boolean }> };
    const contactMissing = start.items.some((i) => i.key === "emergency_contact" && !i.done);
    if (contactMissing) await expect(card.getByTestId("completeness-missing")).toContainText("Emergency contact with relationship");
    const before = Number((await card.getByTestId("completeness-score").innerText()).replace("%", ""));
    expect(before).toBeLessThan(100);
    await card.getByRole("link", { name: "Add it" }).first().click();
    await expect(ess).toHaveURL(/\/app\/profile\?tab=/);

    await ess.goto("/app/ess");
    await expect(ess.getByTestId("completeness-nudge")).toContainText(`${before}% complete`);

    // HR: the record page shows the same score and the work profile can be set
    const hrCtx = await browser.newContext();
    const hr = await hrCtx.newPage();
    await loginToApp(hr, hrToken);
    await hr.goto(`/app/employees/${me.employeeId}`);
    await expect(hr.getByTestId("completeness-score")).toHaveText(`${before}%`);
    const wp = hr.getByTestId("work-profile");
    await expect(wp).toBeVisible();
    await wp.getByRole("button", { name: /Set up|Change/ }).click();
    await wp.getByLabel("Share of a full-time job (%)").fill("60");
    await wp.getByLabel("Hours per week").fill("24");
    await wp.getByRole("button", { name: "Save" }).click();
    await expect(wp.getByTestId("work-profile-summary")).toContainText("Part-time, 60% · 24 h a week");

    // the employee sees it, read-only
    await ess.goto("/app/profile?tab=job");
    await expect(ess.getByTestId("work-profile-summary")).toContainText("Part-time, 60% · 24 h a week");
    await expect(ess.getByTestId("work-profile").getByRole("button", { name: /Change|Set up/ })).toHaveCount(0);

    // HR adds an emergency contact with a relationship: the score goes up
    await api(hrToken, "/employees/contacts", "POST", { employeeId: me.employeeId, contactType: "emergency_contact", value: "0300-1234567", label: "Sara Ali", relationship: "Sister" });
    await ess.goto("/app/profile");
    await expect(ess.getByTestId("completeness-missing")).not.toContainText("Emergency contact with relationship");
    const after = Number((await ess.getByTestId("completeness-score").innerText()).replace("%", ""));
    if (contactMissing) expect(after).toBeGreaterThan(before);
    else expect(after).toBeGreaterThanOrEqual(before);
    await expect(ess.getByTestId("completeness-missing")).not.toContainText("Emergency contact with relationship");
  });

  test("an employee hands approvals to a colleague for a period, and cancels it", async ({ browser }) => {
    const essCtx = await browser.newContext();
    const ess = await essCtx.newPage();
    await loginToApp(ess, getSharedSession("employee_self_service"));
    const coverCtx = await browser.newContext();
    const cover = await coverCtx.newPage();
    await loginToApp(cover, getSharedSession("line_manager"));

    const reasonText = `Annual leave trip ${Date.now()}`;
    await ess.goto("/app/approvals/delegation");
    await ess.getByRole("button", { name: "Save cover arrangement" }).click();
    await expect(ess.getByRole("alert")).toContainText("Choose who will cover for you");
    await ess.getByLabel("Who covers for you?").fill("E2E");
    const option = ess.getByRole("option").filter({ hasText: /line manager/i }).first();
    await expect(option).toBeVisible();
    const who = (await option.innerText()).split(" · ")[0];
    await option.click();
    await ess.getByLabel("I am back on").fill(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
    await ess.getByLabel("Reason").fill(reasonText);
    await ess.getByRole("button", { name: "Save cover arrangement" }).click();
    await expect(ess.getByRole("status")).toContainText("can now approve for you");
    const given = ess.getByTestId("delegation-given").filter({ hasText: reasonText });
    await expect(given).toContainText(who);
    await expect(given).toContainText("Covering now");

    await cover.goto("/app/approvals/delegation");
    await expect(cover.getByTestId("delegation-received").filter({ hasText: reasonText })).toContainText("Covering now");

    await given.getByRole("button", { name: "Cancel" }).click();
    await expect(ess.getByTestId("delegation-given").filter({ hasText: reasonText })).toContainText("Cancelled");
  });
});
