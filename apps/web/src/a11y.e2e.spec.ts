import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { getSharedSession, loginToApp } from "./e2e-support/real-session";

/**
 * Accessibility regression (WCAG 2.0 A and AA, checked by axe-core): the main screens of each area must have no violations,
 * so a colour, label or contrast mistake is caught before it ships. It scans each screen as it first opens.
 */
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const SCREENS: Array<{ role: "hr_admin" | "employee_self_service"; paths: string[] }> = [
  {
    role: "hr_admin",
    paths: [
      "/app", "/app/employees", "/app/employees/analytics", "/app/employees/data-consistency", "/app/employees/smart-checks", "/app/employees/change-requests",
      "/app/hire", "/app/hire/quick", "/app/hire/bulk", "/app/leave/my-requests", "/app/attendance", "/app/payroll", "/app/organization", "/app/performance",
      "/app/recruitment", "/app/learning", "/app/expenses", "/app/travel", "/app/approvals", "/app/reports", "/app/configuration-center",
      "/app/configuration-center/form-settings", "/app/configuration-center/form-designer", "/app/employees/helpdesk", "/app/employees/talent", "/app/employees/esign", "/app/employees/developer",
      "/app/employees/surveys", "/app/employees/headcount", "/app/employees/announcements", "/app/system-admin",
    ],
  },
  { role: "employee_self_service", paths: ["/app/ess", "/app/ess/profile", "/app/ess/helpdesk", "/app/ess/assistant", "/app/ess/recognition", "/app/ess/sign"] },
];

for (const group of SCREENS) {
  test(`no accessibility violations on the ${group.role} screens`, async ({ page }) => {
    test.setTimeout(240000);
    await loginToApp(page, getSharedSession(group.role));
    const problems: string[] = [];
    for (const path of group.paths) {
      await page.goto(path);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await page.waitForTimeout(1200);
      await page.evaluate(axeSource);
      const found = await page.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return r.violations.map((v: any) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes[0].target.join(" ")}`);
      });
      for (const f of found) problems.push(`${path}: ${f}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
