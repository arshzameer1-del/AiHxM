import { BackgroundJobsService } from "../../background-jobs/background-jobs.service";
import { Pool } from "pg";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { RbacService } from "../../rbac/rbac.service";
import { EntitlementsService } from "../../entitlements/entitlements.service";
import { AuditService } from "../../audit/audit.service";
import { ImportExportService } from "../../import-export/import-export.service";
import { EffectiveDatingEngine } from "../../effective-dating/effective-dating.engine";
import { WorkflowService } from "../../workflow/workflow.service";
import { PayrollService } from "../payroll.service";
import { PayrollRunControlService } from "../payroll-run-control.service";
import { EmployeeCompensationService } from "../../employees/employee-compensation.service";
import { RulesEngine } from "../../rules-engine/rules-engine.engine";
import { HolidaysService } from "../../holidays/holidays.service";
import { ShiftsService } from "../../shifts/shifts.service";
import { WorkScheduleResolutionService } from "../../shifts/work-schedule-resolution.service";
import { EmployeeGroupsService } from "../../employee-groups/employee-groups.service";
import { LeaveRequestsService } from "../../leave/leave-requests.service";
import { OvertimeService } from "../../leave/overtime.service";
import { EmployeeLoansService } from "../../employees/employee-loans.service";
import { EmployeeAdditionalPaymentsService } from "../../employees/employee-additional-payments.service";
import { EmployeeOffCyclePaymentsService } from "../../employees/employee-offcycle-payments.service";

export const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "payroll-step9-fixtures" };

/**
 * Shared real-Postgres harness for the Step 9 payroll specs: one company with an HR admin, a distinct
 * payroll approver, a self-service user, an approval workflow template and the real collaborators
 * (no mocks - the same rule payroll.service.spec.ts follows).
 */
export type PayrollFixture = Awaited<ReturnType<typeof buildPayrollFixture>>;

export async function buildPayrollFixture(tag: string) {
  const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
  const db = new DatabaseService(pool);
  const rbac = new RbacService(db);
  const entitlements = new EntitlementsService(db);
  const audit = new AuditService();
  const importExport = new ImportExportService();
  const workflow = new WorkflowService(db, rbac, audit);
  const eff = new EffectiveDatingEngine();
  const shifts = new ShiftsService(db, rbac, entitlements, audit, eff, new RulesEngine());
  const workSchedule = new WorkScheduleResolutionService(db, shifts, new HolidaysService(db, rbac, entitlements, audit));
  const employeeGroups = new EmployeeGroupsService(db, rbac, entitlements, eff, new RulesEngine());
  const leaveRequests = new LeaveRequestsService(db, rbac, entitlements, audit, employeeGroups, workflow, workSchedule);
  const overtime = new OvertimeService(db, rbac, entitlements, audit, eff, workSchedule);
  const loans = new EmployeeLoansService(db, rbac, entitlements, audit);
  const additionalPayments = new EmployeeAdditionalPaymentsService(db, rbac, entitlements, audit);
  const offCyclePayments = new EmployeeOffCyclePaymentsService(db, rbac, entitlements, audit);
  const control = new PayrollRunControlService(db, rbac, entitlements, audit);
  const jobs = new BackgroundJobsService();
  const payroll = new PayrollService(
    db, rbac, entitlements, audit, importExport, eff, workflow, leaveRequests, overtime, workSchedule,
    undefined, undefined, loans, additionalPayments, offCyclePayments, control, jobs
  );
  const compensation = new EmployeeCompensationService(db, rbac, entitlements, audit, eff);
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

  const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) =>
    db.withClaims(FIXTURE_CLAIMS, async (c) => (await c.query(q, p)).rows as T[]);

  const companyId = (
    await db.withClaims(FIXTURE_CLAIMS, async (c) => {
      const co = await c.query("INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id", [`Pay9 ${tag} ${stamp}`, `pay9-${tag}-${stamp}`]);
      await c.query(
        `INSERT INTO company_config (company_id, enabled_modules, employee_number_format)
         VALUES ($1, '["employee","payroll","leave"]'::jsonb, '{"prefix":"EMP","padding":4,"startingSequence":1,"preserveImportedNumbers":true}'::jsonb)`,
        [co.rows[0].id]
      );
      await c.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1,'employee',true),($1,'payroll',true),($1,'leave',true)", [co.rows[0].id]);
      return co.rows[0].id as string;
    })
  );

  const makeUser = async (label: string, roles: string[], forCompany = companyId): Promise<RequestClaims & { uid: string }> => {
    const uid = (await sql<{ id: string }>("INSERT INTO user_accounts (email, password_hash) VALUES ($1,'x') RETURNING id", [`p9-${tag}-${label}-${stamp}@example.com`]))[0].id;
    for (const role of roles) {
      await sql("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1,$2,(SELECT id FROM roles WHERE key=$3))", [uid, forCompany, role]);
    }
    return { is_platform_admin: false, company_id: forCompany, sub: uid, uid };
  };

  const hr = await makeUser("hr", ["hr_admin", "rbac_demo_full_access"]);
  const approver = await makeUser("approver", ["payroll_approver"]);
  const staff = await makeUser("staff", ["employee_self_service"]);
  const approverRole = (await sql<{ id: string }>("SELECT id FROM roles WHERE key = 'payroll_approver'"))[0].id;
  await workflow.createTemplate(hr, {
    key: "payroll_run",
    name: "Payroll Run Approval",
    objectKey: "payroll_run",
    steps: [{ stepOrder: 1, name: "Payroll Approver reviews", approvers: [{ approverType: "role", roleId: approverRole }] }],
  });

  let counter = 0;
  const createEmployee = async (opts: { userAccountId?: string | null; dateOfJoining?: string; terminationDate?: string | null; bank?: string | null; monthlySalary?: number | null; payrollAreaId?: string | null } = {}) => {
    counter += 1;
    const number = `P9${tag.slice(0, 3).toUpperCase()}-${counter}`;
    const row = (
      await sql<{ id: string }>(
        `INSERT INTO employees (company_id, user_account_id, employee_number, first_name, last_name, date_of_joining, termination_date, bank_account_number, payroll_area_id)
         VALUES ($1,$2,$3,'Test','Employee',$4,$5,$6,$7) RETURNING id`,
        [companyId, opts.userAccountId ?? null, number, opts.dateOfJoining ?? "2020-01-01", opts.terminationDate ?? null, opts.bank === undefined ? `PK00-${counter}` : opts.bank, opts.payrollAreaId ?? null]
      )
    )[0];
    if (opts.monthlySalary !== null) {
      await compensation.setCompensation(hr, { employeeId: row.id, monthlySalary: opts.monthlySalary ?? 100000, effectiveFrom: "2020-01-01" });
    }
    return { id: row.id, employeeNumber: number };
  };

  const submitAndApprove = async (runId: string) => {
    await payroll.submitForApproval(hr, runId);
    await payroll.decideApproval(approver, runId, { decision: "approved" });
  };

  const finalizedRun = async (periodStart: string, periodEnd: string) => {
    const run = await payroll.createRun(hr, { periodStart, periodEnd });
    await payroll.calculateRun(hr, run.id);
    await submitAndApprove(run.id);
    await payroll.finalizeRun(hr, run.id);
    return run.id;
  };

  const cleanup = async () => {
    await db.withClaims(FIXTURE_CLAIMS, (c) => c.query("DELETE FROM companies WHERE id = $1", [companyId]));
    await pool.end();
  };

  return {
    pool, db, rbac, entitlements, audit, workflow, payroll, control, jobs, compensation, loans, additionalPayments, offCyclePayments, overtime, leaveRequests,
    workSchedule, companyId, hr, approver, staff, sql, makeUser, createEmployee, submitAndApprove, finalizedRun, cleanup, stamp,
  };
}
