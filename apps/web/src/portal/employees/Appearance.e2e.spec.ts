import { test, expect } from "@playwright/test";
import { API_BASE_URL, getSharedSession, loginToApp } from "../../e2e-support/real-session";

async function api(token: string, path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${API_BASE_URL}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: res.ok ? await res.json().catch(() => null) : await res.text() };
}

// a real 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** BACKLOG55 - the company banner background (System Admin) and the profile photo (employee and HR). */
test.describe("Company appearance and profile photo", () => {
  test("System Admin changes the banner for everyone; HR Admin and employees cannot", async ({ browser }) => {
    const sysToken = getSharedSession("system_admin");
    const hrToken = getSharedSession("hr_admin");
    const essToken = getSharedSession("employee_self_service");
    try {
      const sysCtx = await browser.newContext();
      const sys = await sysCtx.newPage();
      await loginToApp(sys, sysToken);
      await sys.goto("/app/system-admin?tab=appearance");
      const panel = sys.getByTestId("appearance-panel");
      await expect(panel).toBeVisible();
      await panel.getByLabel("A ready-made style").check();
      await panel.getByRole("radio", { name: /Ocean/ }).click();
      await expect(sys.getByTestId("appearance-preview")).toHaveAttribute("style", /rgb\(15, 76, 117\)/);
      await panel.getByRole("button", { name: "Save appearance" }).click();
      await expect(sys.getByRole("status")).toContainText("Saved");

      // a colour that is too light is refused with a plain message
      await panel.getByLabel("One colour").check();
      await panel.getByLabel("Banner colour", { exact: true }).fill("#ffff00");
      await expect(sys.getByRole("alert")).toContainText("too light");

      // an employee sees the new banner on their home page
      const essCtx = await browser.newContext();
      const ess = await essCtx.newPage();
      await loginToApp(ess, essToken);
      await ess.goto("/app");
      await expect(ess.getByTestId("ws-hero")).toHaveAttribute("style", /rgb\(15, 76, 117\)/);

      // only System Admin (or a role that was given the permission) may change it
      expect((await api(hrToken, "/company/appearance", "PUT", { bannerMode: "default" })).status).toBe(403);
      expect((await api(essToken, "/company/appearance", "PUT", { bannerMode: "default" })).status).toBe(403);
      expect(((await api(essToken, "/auth/me")).body as { permissions: string[] }).permissions).not.toContain("company_appearance.manage");
      expect(((await api(sysToken, "/auth/me")).body as { permissions: string[] }).permissions).toContain("company_appearance.manage");
      const hrCtx = await browser.newContext();
      const hr = await hrCtx.newPage();
      await loginToApp(hr, hrToken);
      await expect(hr.getByRole("link", { name: "System Admin" })).toHaveCount(0);
    } finally {
      await api(sysToken, "/company/appearance", "PUT", { bannerMode: "default", photoNeedsHrApproval: false });
    }
  });

  test("the employee and HR can both change the profile photo, and it shows in the top bar and on the home banner", async ({ browser }) => {
    const essToken = getSharedSession("employee_self_service");
    const hrToken = getSharedSession("hr_admin");
    const me = (await api(essToken, "/auth/me")).body as { employeeId: string };

    const essCtx = await browser.newContext();
    const ess = await essCtx.newPage();
    await loginToApp(ess, essToken);
    await ess.goto("/app/profile");
    await ess.getByLabel("Choose a new profile photo").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
    await expect(ess.getByRole("status").filter({ hasText: "Photo updated" })).toBeVisible();
    await expect(ess.getByTestId("profile-photo")).toBeVisible();
    await expect(ess.getByTestId("topbar-photo")).toBeVisible();
    await ess.goto("/app");
    await expect(ess.getByTestId("hero-photo")).toBeVisible();

    // HR changes it from the employee page
    const hrCtx = await browser.newContext();
    const hr = await hrCtx.newPage();
    await loginToApp(hr, hrToken);
    await hr.goto(`/app/employees/${me.employeeId}`);
    const row = hr.getByTestId("employee-photo-row");
    await expect(row.getByTestId("profile-photo")).toBeVisible();
    await row.getByLabel("Choose a new profile photo").setInputFiles({ name: "hr.png", mimeType: "image/png", buffer: PNG });
    await expect(row.getByRole("status")).toContainText("Photo updated");

    // a file that is not an image is refused
    await row.getByLabel("Choose a new profile photo").setInputFiles({ name: "x.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
    await expect(row.getByRole("status")).toContainText(/image|JPEG|PNG/i);
  });

  test("with the company rule switched on, an employee's photo waits for HR", async ({ browser }) => {
    const sysToken = getSharedSession("system_admin");
    const essToken = getSharedSession("employee_self_service");
    try {
      expect((await api(sysToken, "/company/appearance", "PUT", { photoNeedsHrApproval: true })).status).toBe(200);
      const ctx = await browser.newContext();
      const ess = await ctx.newPage();
      await loginToApp(ess, essToken);
      await ess.goto("/app/profile");
      await ess.getByLabel("Choose a new profile photo").setInputFiles({ name: "me2.png", mimeType: "image/png", buffer: PNG });
      await expect(ess.getByRole("status").filter({ hasText: "HR will approve" })).toBeVisible();
    } finally {
      await api(sysToken, "/company/appearance", "PUT", { photoNeedsHrApproval: false });
      // leave nothing waiting, so the next run is not stopped by the limit on waiting uploads
      const hrToken = getSharedSession("hr_admin");
      const pending = ((await api(hrToken, "/employees/documents/pending")).body ?? []) as Array<{ id: string; documentType?: string }>;
      for (const d of pending) await api(hrToken, `/employees/documents/${d.id}/review`, "POST", { decision: "rejected", note: "test clean-up" });
    }
  });
});
