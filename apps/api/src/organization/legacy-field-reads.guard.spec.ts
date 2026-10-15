import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * Gap Register ORG-05 - inventory + guard for reads of the LEGACY employee org fields.
 *
 * `employees.manager_id` and `employees.department` / `employees.location` are no
 * longer sources of truth. The canonical facts are `org_relationships` (direct
 * line), `employee_org_assignments` + `org_units` (placement) and `locations`.
 * The legacy columns are maintained projections (ORG-03: one writer,
 * `OrgOccupancyService`, plus the drift-repair tool; ORG-06/12: name changes are
 * propagated by the org event consumers), kept because ~20 modules still filter
 * on them.
 *
 * This guard fails when a NEW source file starts reading those columns, so every
 * new dependency is a deliberate, reviewed decision: add the file below with its
 * category. Categories:
 *   writer   - maintains the projection; must stay in step with the canonical tables
 *   decision - uses the value for an access / approval / routing decision; read
 *              through the maintained projection (never stale because of ORG-03)
 *   display  - shows or reports the value; staleness is cosmetic
 */
const MANAGER_ID_READERS: Record<string, "writer" | "decision" | "display"> = {
  "database/seed-pilot-company.ts": "display",
  "employees/employee-lifecycle.service.ts": "writer",
  "employees/employees.service.ts": "writer",
  "employees/hiring/hiring-process.service.ts": "writer",
  "employees/person-directory.service.ts": "display",
  "expenses/expense-claims.service.ts": "decision",
  "learning/course-enrollments.service.ts": "decision",
  "leave/attendance-corrections.service.ts": "decision",
  "leave/attendance-evaluation.service.ts": "decision",
  "leave/leave-ledger.service.ts": "decision",
  "leave/leave-requests.service.ts": "decision",
  "leave/on-duty.service.ts": "decision",
  "leave/overtime.service.ts": "decision",
  "leave/timesheets.service.ts": "decision",
  "leave/work-profile.service.ts": "decision",
  "onboarding-offboarding/checklist-access.util.ts": "decision",
  "onboarding-offboarding/onboarding.service.ts": "decision",
  "organization/legacy-reconciliation.service.ts": "writer",
  "organization/occupancy/org-occupancy.service.ts": "writer",
  "organization/org-reconciliation.service.ts": "writer",
  "organization/org-relationships.service.ts": "writer",
  "organization/organization-command-center.service.ts": "display",
  "payroll/payroll-run-control.service.ts": "decision",
  "performance/performance-depth.service.ts": "decision",
  "performance/performance.service.ts": "decision",
  "recruitment/recruitment.service.ts": "decision",
  "shifts/shifts.service.ts": "decision",
  "workflow/workflow.service.ts": "decision",
};

const DEPARTMENT_READERS: Record<string, "writer" | "decision" | "display"> = {
  "employee-groups/employee-groups.service.ts": "decision",
  "employees/employee-analytics.service.ts": "display",
  "employees/employee-lifecycle.service.ts": "writer",
  "employees/employees.service.ts": "writer",
  "organization/legacy-reconciliation.service.ts": "writer",
  "organization/occupancy/org-occupancy.service.ts": "writer",
  "organization/org-changes.service.ts": "writer",
  "organization/org-event-consumers.service.ts": "writer",
  "organization/org-units.service.ts": "writer",
  "organization/organization-command-center.service.ts": "display",
  "organization/positions.service.ts": "writer",
  "recruitment/recruitment-pipeline.service.ts": "display",
  "recruitment/recruitment.service.ts": "writer",
  "shifts/shifts.service.ts": "decision",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      sourceFiles(full, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".spec.ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("ORG-05: reads of the legacy employee org fields are inventoried", () => {
  const root = join(__dirname, "..");
  const files = sourceFiles(root).map((f) => ({ rel: relative(root, f).split("\\").join("/"), text: readFileSync(f, "utf8") }));

  it("only the inventoried files read employees.manager_id", () => {
    const found = files.filter((f) => /\bmanager_id\b/.test(f.text)).map((f) => f.rel);
    const unexpected = found.filter((f) => !(f in MANAGER_ID_READERS));
    expect(unexpected).toEqual([]);
  });

  it("only the inventoried files read employees.department", () => {
    const found = files
      .filter((f) => /(\be\.|employees\.|mgr\.|\bm\.)department\b|SELECT[^;]*\bdepartment\b|department\s*=\s*\$[0-9]/.test(f.text))
      .map((f) => f.rel);
    const unexpected = found.filter((f) => !(f in DEPARTMENT_READERS));
    expect(unexpected).toEqual([]);
  });

  it("every inventoried file still exists (the list is not allowed to rot)", () => {
    const present = new Set(files.map((f) => f.rel));
    const missing = [...Object.keys(MANAGER_ID_READERS), ...Object.keys(DEPARTMENT_READERS)].filter((f) => !present.has(f));
    expect(missing).toEqual([]);
  });
});
