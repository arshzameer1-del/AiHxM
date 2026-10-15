import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EmployeeCompensationService } from "../employees/employee-compensation.service";
import { resolvePayrollAreaAccess } from "./payroll-area-access";
import { payrollRunHooks, type RunRow } from "./payroll-run-hooks";
import type {
  BenefitContributionView,
  BenefitEligibilityView,
  BenefitEnrolmentView,
  BenefitPlanView,
  BenefitType,
  EndBenefitEnrolmentRequest,
  EnrolBenefitRequest,
  UpsertBenefitPlanRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
const CONFIG_PERMISSION = "payroll.calculate.all";
const VIEW_BASES = ["payroll.calculate", "payroll.finalize", "payroll.disburse"];
const BENEFIT_TYPES: BenefitType[] = ["health_insurance", "life_insurance", "pension", "allowance", "loan_scheme", "other"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const day = (v: any): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Whole months from `from` to `to` (a month counts once its day-of-month has been reached). */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const months = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
  return Math.max(0, months);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPlan(r: any): BenefitPlanView {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    benefitType: r.benefit_type,
    description: r.description ?? null,
    employeeComponentId: r.employee_component_id ?? null,
    employeeComponentKey: r.employee_component_key ?? null,
    employerComponentKey: r.employer_component_key ?? null,
    employeeContributionMode: r.employee_contribution_mode,
    employeeContributionValue: num(r.employee_contribution_value),
    employerContributionMode: r.employer_contribution_mode,
    employerContributionValue: num(r.employer_contribution_value),
    minServiceMonths: r.min_service_months === null || r.min_service_months === undefined ? null : Number(r.min_service_months),
    employmentTypes: r.employment_types ?? null,
    payrollAreaId: r.payroll_area_id ?? null,
    effectiveFrom: day(r.effective_from),
    effectiveTo: r.effective_to ? day(r.effective_to) : null,
    status: r.status,
    enrolledCount: Number(r.enrolled_count ?? 0),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEnrolment(r: any): BenefitEnrolmentView {
  return {
    id: r.id,
    planId: r.plan_id,
    planCode: r.plan_code,
    planName: r.plan_name,
    employeeId: r.employee_id,
    employeeNumber: r.employee_number,
    employeeName: `${r.first_name} ${r.last_name}`.trim(),
    status: r.status,
    coverageLevel: r.coverage_level ?? null,
    employeeContributionOverride: num(r.employee_contribution_override),
    effectiveFrom: day(r.effective_from),
    effectiveTo: r.effective_to ? day(r.effective_to) : null,
    endReason: r.end_reason ?? null,
  };
}

/**
 * PAY-22 - the benefits domain: plans, who is eligible, enrolments, and the contributions that came of them.
 * Payroll consumes an enrolment through ordinary pay components, so the gross-to-net engine is untouched: enrolling in a
 * plan that names an employee deduction component writes that employee's amount on the component (fixed amount or
 * percentage, or the per-person override), and ending the enrolment sets it back to zero. When a run is finalised the
 * contribution ledger records, per enrolment, what the payslip lines of the plan's component keys actually deducted and
 * what the employer contributed; reversing the run marks them reversed. Plan figures are the tenant's own.
 */
@Injectable()
export class PayrollBenefitsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly compensation: EmployeeCompensationService
  ) {
    payrollRunHooks.register("payroll-benefits", {
      onFinalized: (client, claims, run) => this.recordContributions(client, claims, run),
      onReversed: (client, claims, run) => this.reverseContributions(client, claims, run),
    });
  }

  // ------------------------------------------------------------------ plans

  async listPlans(claims: RequestClaims, includeInactive = false): Promise<BenefitPlanView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT p.*, (SELECT COUNT(*) FROM benefit_enrolments e WHERE e.plan_id = p.id AND e.status = 'enrolled') AS enrolled_count
           FROM benefit_plans p WHERE ($1::boolean OR p.status = 'active') ORDER BY p.code`,
        [includeInactive]
      );
      return r.rows.map(toPlan);
    });
  }

  async upsertPlan(claims: RequestClaims, input: UpsertBenefitPlanRequest): Promise<BenefitPlanView> {
    await this.requireConfig(claims);
    const code = input.code?.trim();
    if (!code || !/^[A-Za-z0-9_-]{1,40}$/.test(code)) throw new BadRequestException("code must be 1-40 letters, digits, dashes or underscores");
    if (!input.name?.trim()) throw new BadRequestException("name is required");
    if (!DATE_RE.test(input.effectiveFrom ?? "")) throw new BadRequestException("effectiveFrom must be a date (YYYY-MM-DD)");
    if (input.effectiveTo && (!DATE_RE.test(input.effectiveTo) || input.effectiveTo < input.effectiveFrom)) throw new BadRequestException("effectiveTo must be a date on or after effectiveFrom");
    const type = input.benefitType ?? "other";
    if (!BENEFIT_TYPES.includes(type)) throw new BadRequestException(`benefitType must be one of ${BENEFIT_TYPES.join(", ")}`);
    for (const mode of [input.employeeContributionMode, input.employerContributionMode]) {
      if (mode !== undefined && mode !== "fixed" && mode !== "percentage") throw new BadRequestException("A contribution mode is fixed or percentage");
    }
    for (const v of [input.employeeContributionValue, input.employerContributionValue]) {
      if (v !== undefined && v !== null && (!Number.isFinite(v) || v < 0)) throw new BadRequestException("A contribution value cannot be negative");
    }
    if (input.minServiceMonths !== undefined && input.minServiceMonths !== null && (!Number.isInteger(input.minServiceMonths) || input.minServiceMonths < 0)) throw new BadRequestException("minServiceMonths must be a whole number of months");

    return this.db.withClaims(claims, async (client) => {
      let componentKey: string | null = null;
      if (input.employeeComponentId) {
        const c = await client.query("SELECT key, is_active, component_type FROM compensation_components WHERE id = $1", [input.employeeComponentId]);
        if (!c.rowCount) throw new BadRequestException("The employee pay component does not exist");
        if (!c.rows[0].is_active) throw new BadRequestException("The employee pay component is inactive");
        componentKey = c.rows[0].key;
      }
      if (input.employerComponentKey) {
        const c = await client.query("SELECT 1 FROM compensation_components WHERE key = $1", [input.employerComponentKey]);
        if (!c.rowCount) throw new BadRequestException(`No pay component with the key "${input.employerComponentKey}"`);
      }
      if (input.payrollAreaId) {
        const a = await client.query("SELECT 1 FROM payroll_areas WHERE id = $1", [input.payrollAreaId]);
        if (!a.rowCount) throw new BadRequestException("The payroll area does not exist");
      }
      const existing = input.id
        ? await client.query("SELECT * FROM benefit_plans WHERE id = $1 FOR UPDATE", [input.id])
        : await client.query("SELECT * FROM benefit_plans WHERE code = $1 FOR UPDATE", [code]);
      const values = [
        code, input.name.trim(), type, input.description?.trim() || null, input.employeeComponentId ?? null, componentKey, input.employerComponentKey ?? null,
        input.employeeContributionMode ?? "fixed", input.employeeContributionValue ?? null, input.employerContributionMode ?? "fixed", input.employerContributionValue ?? null,
        input.minServiceMonths ?? null, input.employmentTypes?.length ? input.employmentTypes : null, input.payrollAreaId ?? null, input.effectiveFrom, input.effectiveTo ?? null,
        input.status ?? "active",
      ];
      let row;
      if (existing.rowCount) {
        const u = await client.query(
          `UPDATE benefit_plans SET code = $2, name = $3, benefit_type = $4, description = $5, employee_component_id = $6, employee_component_key = $7, employer_component_key = $8,
                  employee_contribution_mode = $9, employee_contribution_value = $10, employer_contribution_mode = $11, employer_contribution_value = $12,
                  min_service_months = $13, employment_types = $14, payroll_area_id = $15, effective_from = $16, effective_to = $17, status = $18, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [existing.rows[0].id, ...values]
        );
        row = u.rows[0];
      } else {
        const i = await client.query(
          `INSERT INTO benefit_plans (company_id, code, name, benefit_type, description, employee_component_id, employee_component_key, employer_component_key,
                  employee_contribution_mode, employee_contribution_value, employer_contribution_mode, employer_contribution_value,
                  min_service_months, employment_types, payroll_area_id, effective_from, effective_to, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
          [claims.company_id, ...values, claims.sub]
        );
        row = i.rows[0];
      }
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: existing.rowCount ? "benefit_plan.update" : "benefit_plan.create",
        target: row.id,
        metadata: { code, benefitType: type, effectiveFrom: input.effectiveFrom, status: row.status },
      });
      const count = await client.query("SELECT COUNT(*) AS n FROM benefit_enrolments WHERE plan_id = $1 AND status = 'enrolled'", [row.id]);
      return toPlan({ ...row, enrolled_count: count.rows[0].n });
    });
  }

  // ------------------------------------------------------------------ eligibility and enrolment

  async checkEligibility(claims: RequestClaims, planId: string, employeeId: string, asOf?: string): Promise<BenefitEligibilityView> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const plan = await this.loadPlan(client, planId);
      const emp = await this.loadEmployee(client, employeeId);
      return this.evaluate(plan, emp, asOf ?? new Date().toISOString().slice(0, 10));
    });
  }

  private evaluate(plan: RunRow, emp: RunRow, asOf: string): BenefitEligibilityView {
    const reasons: string[] = [];
    const serviceMonths = emp.date_of_joining ? monthsBetween(day(emp.date_of_joining), asOf) : 0;
    if (plan.status !== "active") reasons.push("The plan is inactive");
    if (asOf < day(plan.effective_from)) reasons.push(`The plan starts on ${day(plan.effective_from)}`);
    if (plan.effective_to && asOf > day(plan.effective_to)) reasons.push(`The plan ended on ${day(plan.effective_to)}`);
    if (plan.min_service_months !== null && serviceMonths < Number(plan.min_service_months)) reasons.push(`Needs ${plan.min_service_months} month(s) of service; the employee has ${serviceMonths}`);
    if (plan.employment_types?.length && !plan.employment_types.includes(emp.employment_type)) reasons.push(`Open to ${plan.employment_types.join(", ")} employees only`);
    if (plan.payroll_area_id && plan.payroll_area_id !== emp.payroll_area_id) reasons.push("The employee is not in the plan's payroll area");
    if (emp.termination_date && day(emp.termination_date) <= asOf) reasons.push("The employee has left");
    return { eligible: reasons.length === 0, reasons, serviceMonths };
  }

  async enrol(claims: RequestClaims, input: EnrolBenefitRequest): Promise<BenefitEnrolmentView> {
    await this.requireConfig(claims);
    if (!DATE_RE.test(input.effectiveFrom ?? "")) throw new BadRequestException("effectiveFrom must be a date (YYYY-MM-DD)");
    if (input.employeeContributionOverride !== undefined && input.employeeContributionOverride !== null && (!Number.isFinite(input.employeeContributionOverride) || input.employeeContributionOverride < 0)) {
      throw new BadRequestException("The contribution override cannot be negative");
    }
    return this.db.withClaims(claims, async (client) => {
      const plan = await this.loadPlan(client, input.planId);
      const emp = await this.loadEmployee(client, input.employeeId);
      const dup = await client.query("SELECT 1 FROM benefit_enrolments WHERE plan_id = $1 AND employee_id = $2 AND status = 'enrolled'", [plan.id, emp.id]);
      if (dup.rowCount) throw new ConflictException("This employee is already enrolled in the plan");
      if (!input.waive) {
        const verdict = this.evaluate(plan, emp, input.effectiveFrom);
        if (!verdict.eligible) throw new BadRequestException(`Not eligible: ${verdict.reasons.join("; ")}`);
      }
      const r = await client.query(
        `INSERT INTO benefit_enrolments (company_id, plan_id, employee_id, status, coverage_level, employee_contribution_override, effective_from, enrolled_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [claims.company_id, plan.id, emp.id, input.waive ? "waived" : "enrolled", input.coverageLevel?.trim() || null, input.employeeContributionOverride ?? null, input.effectiveFrom, claims.sub]
      );
      if (!input.waive) await this.syncComponent(claims, plan, emp.id, input.effectiveFrom, input.employeeContributionOverride ?? null, false);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: input.waive ? "benefit_enrolment.waive" : "benefit_enrolment.enrol",
        target: r.rows[0].id,
        metadata: { planCode: plan.code, employeeId: emp.id, effectiveFrom: input.effectiveFrom },
      });
      return this.viewEnrolment(client, r.rows[0].id);
    });
  }

  async endEnrolment(claims: RequestClaims, enrolmentId: string, input: EndBenefitEnrolmentRequest): Promise<BenefitEnrolmentView> {
    await this.requireConfig(claims);
    if (!DATE_RE.test(input.effectiveTo ?? "")) throw new BadRequestException("effectiveTo must be a date (YYYY-MM-DD)");
    const reason = input.reason?.trim();
    if (!reason || reason.length < 3) throw new BadRequestException("A reason is required");
    return this.db.withClaims(claims, async (client) => {
      const cur = await client.query("SELECT * FROM benefit_enrolments WHERE id = $1 FOR UPDATE", [enrolmentId]);
      if (!cur.rowCount) throw new NotFoundException("Enrolment not found");
      const e = cur.rows[0];
      if (e.status !== "enrolled") throw new BadRequestException(`Only a current enrolment can be ended (this one is ${e.status})`);
      if (input.effectiveTo < day(e.effective_from)) throw new BadRequestException("effectiveTo cannot be before the enrolment started");
      const plan = await this.loadPlan(client, e.plan_id);
      await client.query("UPDATE benefit_enrolments SET status = 'ended', effective_to = $2, end_reason = $3, ended_by = $4, updated_at = now() WHERE id = $1", [enrolmentId, input.effectiveTo, reason, claims.sub]);
      // the deduction stops the day after the last covered day
      const stop = new Date(`${input.effectiveTo}T00:00:00Z`);
      stop.setUTCDate(stop.getUTCDate() + 1);
      await this.syncComponent(claims, plan, e.employee_id, stop.toISOString().slice(0, 10), null, true);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "benefit_enrolment.end",
        target: enrolmentId,
        metadata: { planCode: plan.code, employeeId: e.employee_id, effectiveTo: input.effectiveTo, reason },
      });
      return this.viewEnrolment(client, enrolmentId);
    });
  }

  async listEnrolments(claims: RequestClaims, filter: { planId?: string; employeeId?: string; status?: string } = {}): Promise<BenefitEnrolmentView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT e.*, p.code AS plan_code, p.name AS plan_name, m.employee_number, m.first_name, m.last_name
           FROM benefit_enrolments e JOIN benefit_plans p ON p.id = e.plan_id JOIN employees m ON m.id = e.employee_id
          WHERE ($1::uuid IS NULL OR e.plan_id = $1) AND ($2::uuid IS NULL OR e.employee_id = $2) AND ($3::text IS NULL OR e.status = $3)
          ORDER BY m.employee_number, p.code LIMIT 1000`,
        [filter.planId ?? null, filter.employeeId ?? null, filter.status ?? null]
      );
      return r.rows.map(toEnrolment);
    });
  }

  async listContributions(claims: RequestClaims, filter: { planId?: string; employeeId?: string; runId?: string } = {}): Promise<BenefitContributionView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT c.*, m.employee_number FROM benefit_contributions c JOIN employees m ON m.id = c.employee_id
          WHERE ($1::uuid IS NULL OR c.plan_id = $1) AND ($2::uuid IS NULL OR c.employee_id = $2) AND ($3::uuid IS NULL OR c.payroll_run_id = $3)
          ORDER BY c.period_end DESC, m.employee_number LIMIT 1000`,
        [filter.planId ?? null, filter.employeeId ?? null, filter.runId ?? null]
      );
      return r.rows.map((x) => ({
        id: x.id,
        planId: x.plan_id,
        enrolmentId: x.enrolment_id,
        employeeId: x.employee_id,
        employeeNumber: x.employee_number,
        payrollRunId: x.payroll_run_id,
        periodEnd: day(x.period_end),
        employeeAmount: Number(x.employee_amount),
        employerAmount: Number(x.employer_amount),
        status: x.status,
      }));
    });
  }

  // ------------------------------------------------------------------ run hooks

  private async recordContributions(client: PoolClient, claims: RequestClaims, run: RunRow): Promise<void> {
    if (run.is_simulation) return;
    const plans = await client.query(
      "SELECT * FROM benefit_plans WHERE company_id = $1 AND (employee_component_key IS NOT NULL OR employer_component_key IS NOT NULL)",
      [run.company_id]
    );
    for (const plan of plans.rows) {
      const keys = [plan.employee_component_key, plan.employer_component_key].filter(Boolean) as string[];
      const lines = await client.query(
        `SELECT c.payslip_id, c.employee_id, c.component_key, SUM(c.amount) AS amount
           FROM payroll_component_results c JOIN payslips s ON s.id = c.payslip_id
          WHERE c.payroll_run_id = $1 AND s.status <> 'voided' AND c.component_key = ANY($2::text[])
          GROUP BY c.payslip_id, c.employee_id, c.component_key`,
        [run.id, keys]
      );
      const byEmployee = new Map<string, { payslipId: string; employee: number; employer: number }>();
      for (const l of lines.rows) {
        const cur = byEmployee.get(l.employee_id) ?? { payslipId: l.payslip_id, employee: 0, employer: 0 };
        if (l.component_key === plan.employee_component_key) cur.employee += -Number(l.amount); // a deduction is negative on the payslip
        else cur.employer += Number(l.amount);
        byEmployee.set(l.employee_id, cur);
      }
      for (const [employeeId, amounts] of byEmployee) {
        const enr = await client.query(
          `SELECT id FROM benefit_enrolments WHERE plan_id = $1 AND employee_id = $2 AND status IN ('enrolled', 'ended')
              AND effective_from <= $4::date AND (effective_to IS NULL OR effective_to >= $3::date) ORDER BY effective_from DESC LIMIT 1`,
          [plan.id, employeeId, day(run.period_start), day(run.period_end)]
        );
        if (!enr.rowCount) continue;
        const employee = r2(amounts.employee);
        const employer = r2(amounts.employer);
        if (!(employee > 0) && !(employer > 0)) continue;
        await client.query(
          `INSERT INTO benefit_contributions (company_id, enrolment_id, plan_id, employee_id, payroll_run_id, payslip_id, period_end, employee_amount, employer_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (enrolment_id, payroll_run_id) DO NOTHING`,
          [run.company_id, enr.rows[0].id, plan.id, employeeId, run.id, amounts.payslipId, day(run.period_end), Math.max(employee, 0), Math.max(employer, 0)]
        );
      }
    }
    void claims;
  }

  private async reverseContributions(client: PoolClient, _claims: RequestClaims, run: RunRow): Promise<void> {
    await client.query("UPDATE benefit_contributions SET status = 'reversed', reversed_at = now() WHERE payroll_run_id = $1 AND status = 'accrued'", [run.id]);
  }

  // ------------------------------------------------------------------ internals

  /** Writes (or zeroes) the employee's amount on the plan's deduction component, as of `from`. */
  private async syncComponent(claims: RequestClaims, plan: RunRow, employeeId: string, from: string, override: number | null, zero: boolean): Promise<void> {
    if (!plan.employee_component_id) return;
    const mode = plan.employee_contribution_mode as "fixed" | "percentage";
    const value = zero ? 0 : override ?? num(plan.employee_contribution_value);
    if (value === null) return; // the plan names a component but no figure yet: nothing to write
    await this.compensation.setCompensationComponents(claims, {
      employeeId,
      effectiveFrom: from,
      components: [mode === "percentage" ? { componentId: plan.employee_component_id, percentage: value } : { componentId: plan.employee_component_id, amount: value }],
      changeReasonNote: zero ? `Benefit enrolment in ${plan.code} ended` : `Benefit enrolment in ${plan.code}`,
    });
  }

  private async loadPlan(client: PoolClient, id: string): Promise<RunRow> {
    const r = await client.query("SELECT * FROM benefit_plans WHERE id = $1", [id]);
    if (!r.rowCount) throw new NotFoundException("Benefit plan not found");
    return r.rows[0];
  }

  private async loadEmployee(client: PoolClient, id: string): Promise<RunRow> {
    const r = await client.query("SELECT * FROM employees WHERE id = $1", [id]);
    if (!r.rowCount) throw new NotFoundException("Employee not found");
    return r.rows[0];
  }

  private async viewEnrolment(client: PoolClient, id: string): Promise<BenefitEnrolmentView> {
    const r = await client.query(
      `SELECT e.*, p.code AS plan_code, p.name AS plan_name, m.employee_number, m.first_name, m.last_name
         FROM benefit_enrolments e JOIN benefit_plans p ON p.id = e.plan_id JOIN employees m ON m.id = e.employee_id WHERE e.id = $1`,
      [id]
    );
    return toEnrolment(r.rows[0]);
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await resolvePayrollAreaAccess(this.db, this.rbac, claims, VIEW_BASES)) && !(await this.rbac.can(claims, "payroll.manage.all"))) {
      throw new ForbiddenException("Not permitted to view benefits");
    }
  }

  private async requireConfig(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.rbac.can(claims, CONFIG_PERMISSION)) && !(await this.rbac.can(claims, "payroll.manage.all"))) throw new ForbiddenException("Not permitted to manage benefits");
  }
}
