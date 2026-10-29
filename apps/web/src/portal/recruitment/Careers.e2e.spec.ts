import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { API_BASE_URL, getSharedSession, loginToApp } from "../../e2e-support/real-session";

/**
 * HR switches the careers page on and publishes an approved job; a visitor with no account applies with a resume; HR sees
 * the candidate; HR unpublishes and the job disappears. Requisition approval needs a workflow template the shared test
 * company does not have, so the one approval step is done directly in the database (the rest is the real UI and API).
 */
test.describe("Careers page", () => {
  test("publish, apply as a visitor, see the candidate, unpublish", async ({ browser }) => {
    const stamp = Date.now();
    const title = `Support Engineer ${stamp}`;
    const token = getSharedSession("hr_admin");
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const me = await (await fetch(`${API_BASE_URL}/auth/me`, { headers: auth })).json();
    const slug: string = me.companySlug;
    const created = await (await fetch(`${API_BASE_URL}/job-requisitions`, { method: "POST", headers: auth, body: JSON.stringify({ title, department: "Support", headcount: 1, salaryBand: "SECRET-BAND" }) })).json();
    const db = new Client({ connectionString: (process.env.DATABASE_URL ?? "").split("?")[0] });
    await db.connect();
    await db.query("UPDATE job_requisitions SET status = 'approved' WHERE id = $1", [created.id]);
    await db.end();

    const hr = await (await browser.newContext()).newPage();
    await loginToApp(hr, token);
    await hr.goto("/app/recruitment");
    await hr.getByRole("button", { name: "Settings" }).click();
    await hr.getByLabel("Show a public careers page for this company").check();
    await hr.locator("#rs-intro").fill("Come build with us.");
    await hr.getByRole("button", { name: "Save settings" }).click();
    await expect(hr.getByText("Saved")).toBeVisible();

    await hr.getByRole("button", { name: "Careers page" }).click();
    const row = hr.getByTestId("careers-row").filter({ hasText: title });
    await row.getByRole("button", { name: "Publish" }).click();
    await row.getByRole("button", { name: "Publish", exact: true }).last().click();
    await expect(hr.getByRole("alert")).toContainText("job description");
    await row.getByLabel("What the public reads about this job").fill("Help customers succeed. Remote friendly.");
    await row.getByLabel("Location").fill("Lahore");
    await row.getByRole("button", { name: "Publish", exact: true }).last().click();
    await expect(row).toContainText("Published");

    // a visitor: no session at all
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(`/careers/${slug}`);
    await expect(visitor.getByRole("heading", { name: /^Careers at/ })).toBeVisible();
    await expect(visitor.getByText("Come build with us.")).toBeVisible();
    await visitor.getByRole("link", { name: new RegExp(title) }).click();
    await expect(visitor.getByText("Help customers succeed.")).toBeVisible();
    await expect(visitor.locator("body")).not.toContainText("SECRET-BAND");
    await expect(visitor.getByRole("button", { name: "Submit application" })).toBeDisabled();
    await visitor.locator("#ap-first").fill("Priya");
    await visitor.locator("#ap-last").fill(`Careers${stamp}`);
    await visitor.locator("#ap-email").fill(`priya.${stamp}@example.com`);
    await visitor.locator("#ap-resume").setInputFiles({ name: "cv.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 e2e resume") });
    await visitor.getByLabel(/I agree to/).check();
    await visitor.getByRole("button", { name: "Submit application" }).click();
    await expect(visitor.getByText("Application received")).toBeVisible();

    await hr.getByRole("button", { name: "Candidates" }).click();
    await expect(hr.getByText(`Careers${stamp}`).first()).toBeVisible();

    await hr.getByRole("button", { name: "Careers page" }).click();
    const again = hr.getByTestId("careers-row").filter({ hasText: title });
    await expect(again).toContainText("1 application");
    await again.getByRole("button", { name: "Edit" }).click();
    await again.getByRole("button", { name: "Unpublish" }).click();
    await expect(again).toContainText("Not published");
    await visitor.goto(`/careers/${slug}`);
    await expect(visitor.getByText(title)).toHaveCount(0);

    // leave the shared company as we found it: other specs expect an empty recruitment module
    const cleanup = new Client({ connectionString: (process.env.DATABASE_URL ?? "").split("?")[0] });
    await cleanup.connect();
    const companyId = (await cleanup.query("SELECT company_id FROM job_requisitions WHERE id = $1", [created.id])).rows[0].company_id;
    await cleanup.query("DELETE FROM applications WHERE requisition_id = $1", [created.id]);
    await cleanup.query("DELETE FROM candidates WHERE email = $1", [`priya.${stamp}@example.com`]);
    await cleanup.query("DELETE FROM job_requisitions WHERE id = $1", [created.id]);
    await cleanup.query("DELETE FROM recruitment_settings WHERE company_id = $1", [companyId]);
    await cleanup.end();
  });
});
