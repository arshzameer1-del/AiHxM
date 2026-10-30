import { test, expect } from "@playwright/test";
import { API_BASE_URL, getSharedSession, loginToApp } from "../../e2e-support/real-session";

async function api(token: string, path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${API_BASE_URL}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: res.ok ? await res.json().catch(() => null) : await res.text() };
}

/** BACKLOG54 - languages, medical information and disciplinary records, and who can see them. */
test.describe("Languages, medical information and disciplinary records", () => {
  test("the employee reads and acknowledges a notice, keeps their medical information, HR withdraws and adds a language", async ({ browser }) => {
    const stamp = Date.now();
    const essToken = getSharedSession("employee_self_service");
    const hrToken = getSharedSession("hr_admin");
    const managerToken = getSharedSession("line_manager");
    const me = (await api(essToken, "/auth/me")).body as { employeeId: string };

    // HR issues a notice (through the API; the HR screen is exercised below)
    const subject = `Late arrival ${stamp}`;
    const issued = await api(hrToken, "/employees/disciplinary", "POST", { employeeId: me.employeeId, recordType: "written_warning", subject, description: "Late on six days without notice." });
    expect(issued.status).toBe(201);

    const essCtx = await browser.newContext();
    const ess = await essCtx.newPage();
    await loginToApp(ess, essToken);
    await ess.goto("/app/profile?tab=disciplinary");
    const row = ess.getByTestId("disciplinary-row").filter({ hasText: subject });
    await expect(row).toBeVisible();
    await expect(ess.getByTestId("disciplinary-waiting")).toBeVisible();
    await row.getByRole("button", { name: "Acknowledge" }).click();
    await row.getByLabel("Your comment (optional)").fill("Understood, I will leave earlier.");
    await row.getByRole("button", { name: "Acknowledge" }).last().click();
    await expect(row).toContainText("Acknowledged");
    await expect(row).toContainText("I will leave earlier");

    // medical information, kept by the employee
    await ess.goto("/app/profile?tab=medical");
    const panel = ess.getByTestId("medical-panel");
    await panel.getByRole("button", { name: /Add|Edit/ }).click();
    await panel.getByLabel("Blood group").selectOption("B+");
    await panel.getByLabel("Allergies").fill(`Dust ${stamp}`);
    await panel.getByRole("button", { name: "Save" }).click();
    await expect(panel.getByTestId("medical-summary")).toContainText("B+");
    await expect(panel.getByTestId("medical-summary")).toContainText(`Dust ${stamp}`);

    // HR sees both on the employee page and withdraws the notice
    const hrCtx = await browser.newContext();
    const hr = await hrCtx.newPage();
    await loginToApp(hr, hrToken);
    await hr.goto(`/app/employees/${me.employeeId}`);
    await hr.getByRole("button", { name: "Medical & Discipline" }).click();
    await expect(hr.getByTestId("medical-summary")).toContainText(`Dust ${stamp}`);
    const hrRow = hr.getByTestId("disciplinary-row").filter({ hasText: subject });
    await expect(hrRow).toContainText("Acknowledged");
    await hrRow.getByRole("button", { name: "Withdraw" }).click();
    await hrRow.getByLabel("Why is it being withdrawn?").fill("Approved by the manager");
    await hrRow.getByRole("button", { name: "Withdraw record" }).click();
    await expect(hrRow).toContainText("Withdrawn");
    await expect(hrRow).toContainText("Approved by the manager");

    // HR adds a language on Family & Education; the employee sees it
    await hr.getByRole("button", { name: "Family & Education" }).click();
    const lang = `Sindhi${stamp}`;
    await hr.getByLabel("Language", { exact: true }).fill(lang);
    await hr.getByLabel("Speaking").selectOption("native");
    await hr.getByRole("button", { name: "Add language" }).click();
    await expect(hr.getByTestId("language-row").filter({ hasText: lang })).toContainText("speaks native");
    await ess.goto("/app/profile?tab=family");
    const mine = ess.getByTestId("language-row").filter({ hasText: lang });
    await expect(mine).toBeVisible();
    await expect(mine.getByRole("button", { name: "Remove" })).toHaveCount(0);

    // HR is asked before a language is removed; Cancel keeps it, confirming removes it
    await hr.getByTestId("language-row").filter({ hasText: lang }).getByRole("button", { name: "Remove" }).click();
    await hr.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await expect(hr.getByTestId("language-row").filter({ hasText: lang })).toHaveCount(1);
    await hr.getByTestId("language-row").filter({ hasText: lang }).getByRole("button", { name: "Remove" }).click();
    await hr.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(hr.getByTestId("language-row").filter({ hasText: lang })).toHaveCount(0);

    // a line manager is refused outright
    expect((await api(managerToken, `/employees/medical?employeeId=${me.employeeId}`)).status).toBe(403);
    expect((await api(managerToken, `/employees/disciplinary?employeeId=${me.employeeId}`)).status).toBe(403);
  });

  test("an employee cannot issue a notice or read a colleague's records", async () => {
    const essToken = getSharedSession("employee_self_service");
    const hrToken = getSharedSession("hr_admin");
    const managerToken = getSharedSession("line_manager");
    const me = (await api(essToken, "/auth/me")).body as { employeeId: string };
    const mgr = (await api(managerToken, "/auth/me")).body as { employeeId: string | null };
    expect((await api(essToken, "/employees/disciplinary", "POST", { employeeId: me.employeeId, recordType: "other", subject: "self", description: "self" })).status).toBe(403);
    if (mgr.employeeId) {
      expect((await api(essToken, `/employees/medical?employeeId=${mgr.employeeId}`)).status).toBe(403);
      expect((await api(essToken, `/employees/disciplinary?employeeId=${mgr.employeeId}`)).status).toBe(403);
    }
    expect((await api(hrToken, `/employees/medical?employeeId=${me.employeeId}`)).status).toBe(200);
  });
});
