import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { sequentially } from "../database/sequentially";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import type { EmployeeConsistencyReport, EmployeeConsistencyRepairResult } from "@aihxm/shared-types";
import { CONSISTENCY_CHECKS } from "./employee-data-consistency.checks";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";
const SAMPLE_SIZE = 5;

/**
 * BACKLOG46 — shows HR where the employee record disagrees with the place that owns the value
 * (organisation unit, position, location, contact records, reporting line, payment accounts, salary)
 * and repairs the mismatches that have one obviously right answer. Company-wide, so it needs
 * `employee.manage.all` like Workforce Analytics does.
 */
@Injectable()
export class EmployeeDataConsistencyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService
  ) {}

  async getReport(claims: RequestClaims): Promise<EmployeeConsistencyReport> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.buildReport(client, claims.company_id!));
  }

  async repair(claims: RequestClaims): Promise<EmployeeConsistencyRepairResult> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const res = await client.query<{ r: Record<string, number> }>("SELECT app.repair_employee_consistency($1) AS r", [claims.company_id]);
      const repaired = res.rows[0]?.r ?? {};
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee.data_consistency.repair",
        target: claims.company_id ?? null,
        metadata: repaired,
      });
      const report = await this.buildReport(client, claims.company_id!);
      return { repaired, report };
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async buildReport(client: any, companyId: string): Promise<EmployeeConsistencyReport> {
    const total = await client.query("SELECT COUNT(*)::int AS n FROM employees WHERE company_id = $1", [companyId]);
    const checks = await sequentially(
      CONSISTENCY_CHECKS.map((c) => async () => {
        const from = `FROM employees e ${c.joins ?? ""} WHERE e.company_id = $1 AND (${c.where})`;
        const count = await client.query(`SELECT COUNT(*)::int AS n ${from}`, [companyId]);
        const n: number = count.rows[0].n;
        let samples: EmployeeConsistencyReport["checks"][number]["samples"] = [];
        if (n > 0) {
          const rows = await client.query(
            `SELECT e.id, e.employee_number, e.first_name || ' ' || e.last_name AS name, (${c.detail}) AS detail
             ${from} ORDER BY e.employee_number LIMIT ${SAMPLE_SIZE}`,
            [companyId]
          );
          samples = rows.rows.map((r: { id: string; employee_number: string; name: string; detail: string }) => ({
            employeeId: r.id,
            employeeNumber: r.employee_number,
            name: r.name,
            detail: r.detail ?? "",
          }));
        }
        return { id: c.id, label: c.label, explanation: c.explanation, severity: c.severity, fixable: c.fixable, count: n, samples };
      })
    );
    const totalIssues = checks.reduce((a, c) => a + c.count, 0);
    const fixableIssues = checks.filter((c) => c.fixable).reduce((a, c) => a + c.count, 0);
    return {
      generatedAt: new Date().toISOString(),
      employeesChecked: total.rows[0].n,
      totalIssues,
      fixableIssues,
      checks,
    };
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Requires HR Admin");
    }
  }
}
