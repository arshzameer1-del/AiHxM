import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { API_BASE_URL, getSharedSession, loginToApp } from "../../e2e-support/real-session";

/** HR builds a course with an exam and a learning path and assigns it; the employee sits the exam and gets a certificate. */
test.describe("Learning paths and exams", () => {
  test("build, assign, take the exam, certificate", async ({ page, browser }) => {
    const stamp = Date.now();
    const courseTitle = `E2E Safety ${stamp}`;
    const pathTitle = `E2E Induction ${stamp}`;
    const hr = getSharedSession("hr_admin");
    const ess = getSharedSession("employee_self_service");
    const sub = JSON.parse(Buffer.from(ess.split(".")[1], "base64url").toString()).sub as string;
    const db = new Client({ connectionString: (process.env.DATABASE_URL ?? "").split("?")[0] });
    await db.connect();
    try {
      const emp = (await db.query("SELECT id, first_name, last_name FROM employees WHERE user_account_id = $1", [sub])).rows[0];
      expect(emp).toBeTruthy();

      const created = await fetch(`${API_BASE_URL}/courses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${hr}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: courseTitle, category: "compliance", durationMinutes: 20 }),
      });
      expect(created.ok).toBe(true);

      // HR: the exam on the course
      await loginToApp(page, hr);
      await page.goto("/app/learning");
      await page.getByRole("tab", { name: "Browse Courses" }).click();
      const card = page.locator("div.bg-card").filter({ hasText: courseTitle }).last();
      await card.getByRole("button", { name: "Exam" }).click();
      const editor = page.getByRole("form", { name: `Exam for ${courseTitle}` });
      await editor.getByLabel("Pass mark (%)").fill("50");
      await editor.getByLabel("Question 1", { exact: true }).fill("Which colour means stop?");
      await editor.getByLabel("Question 1 choice 1").fill("Green");
      await editor.getByLabel("Question 1 choice 2").fill("Red");
      await editor.getByLabel("Choice 2 of question 1 is correct").check();
      await editor.getByRole("button", { name: "Save exam" }).click();
      await expect(page.getByRole("form", { name: `Exam for ${courseTitle}` })).toBeHidden();

      // HR: a path with that course, assigned to the employee
      await page.getByRole("tab", { name: "Manage Paths" }).click();
      await page.getByRole("button", { name: "New path" }).click();
      const pathForm = page.getByRole("form", { name: "New learning path" });
      await pathForm.getByLabel("Path title").fill(pathTitle);
      await pathForm.getByLabel("Course to add").selectOption({ label: courseTitle });
      await pathForm.getByRole("button", { name: "Add", exact: true }).click();
      await pathForm.getByRole("button", { name: "Create path" }).click();
      await expect(page.getByText("Path created.")).toBeVisible();

      const row = page.locator("div.bg-card").filter({ hasText: pathTitle }).last();
      await row.getByRole("button", { name: "Assign" }).click();
      const assign = page.getByRole("form", { name: `Assign ${pathTitle}` });
      await assign.getByLabel("Find people").fill(`${emp.first_name} ${emp.last_name}`);
      await assign.getByRole("checkbox", { name: new RegExp(`${emp.first_name} ${emp.last_name}`) }).first().check();
      await assign.getByRole("button", { name: /^Assign to 1 person/ }).click();
      await expect(page.getByText(/1 assigned/).first()).toBeVisible();

      // the employee: fails once, then passes, then opens the certificate
      const mine = await browser.newPage();
      await loginToApp(mine, ess);
      await mine.goto("/app/learning");
      await mine.getByRole("tab", { name: "Learning Paths" }).click();
      const mypath = mine.getByRole("region", { name: pathTitle });
      await expect(mypath).toBeVisible();
      await mypath.getByRole("button", { name: "Take exam" }).click();
      const exam = mine.getByRole("form", { name: /^Exam:/ });
      await exam.getByLabel("Green").check();
      await exam.getByRole("button", { name: "Submit answers" }).click();
      await expect(mine.getByText("Not passed yet")).toBeVisible();
      await mine.getByRole("button", { name: "Close" }).click();

      await mypath.getByRole("button", { name: "Take exam" }).click();
      await mine.getByRole("form", { name: /^Exam:/ }).getByLabel("Red").check();
      await mine.getByRole("form", { name: /^Exam:/ }).getByRole("button", { name: "Submit answers" }).click();
      await expect(mine.getByText("You passed")).toBeVisible();
      await mine.getByRole("button", { name: "Close" }).click();

      await mypath.getByRole("button", { name: "Certificate" }).click();
      await expect(mine.getByText("Certificate of Completion")).toBeVisible();
      await expect(mine.getByText(`${emp.first_name} ${emp.last_name}`).first()).toBeVisible();
      await expect(mine.getByText(courseTitle).first()).toBeVisible();
      await mine.close();

      // HR sees the path finished
      await page.getByRole("tab", { name: "Manage Paths" }).click();
      await page.locator("div.bg-card").filter({ hasText: pathTitle }).last().getByRole("button", { name: "Progress" }).click();
      await expect(page.getByRole("region", { name: `Progress on ${pathTitle}` }).getByText("1/1")).toBeVisible();
    } finally {
      await db.query("DELETE FROM learning_paths WHERE title = $1", [pathTitle]);
      await db.query("DELETE FROM courses WHERE title = $1", [courseTitle]);
      await db.end();
    }
  });
});
