import { Pool } from "pg";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ValidationPipe } from "@nestjs/common";
import type { PayrollFormulaExpression, PayslipView } from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { RbacService } from "../rbac/rbac.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { ImportExportService } from "../import-export/import-export.service";
import { EffectiveDatingEngine } from "../effective-dating/effective-dating.engine";
import { WorkflowService } from "../workflow/workflow.service";
import { RulesEngine } from "../rules-engine/rules-engine.engine";
import { HolidaysService } from "../holidays/holidays.service";
import { ShiftsService } from "../shifts/shifts.service";
import { WorkScheduleResolutionService } from "../shifts/work-schedule-resolution.service";
import { EmployeeGroupsService } from "../employee-groups/employee-groups.service";
import { LeaveRequestsService } from "../leave/leave-requests.service";
import { OvertimeService } from "../leave/overtime.service";
import { EmployeeLoansService } from "../employees/employee-loans.service";
import { EmployeeAdditionalPaymentsService } from "../employees/employee-additional-payments.service";
import { EmployeeOffCyclePaymentsService } from "../employees/employee-offcycle-payments.service";
import { EmployeeCompensationService } from "../employees/employee-compensation.service";
import { PayrollService } from "./payroll.service";
import { FormulaExpressionEngine } from "./formula-expression.engine";
import { PayrollFormulaService } from "./payroll-formula.service";
import { PayrollFormulaOverridesService } from "./payroll-formula-overrides.service";
import { CreatePayrollFormulaDto } from "./dto/payroll-formula.dto";

const FIXTURE_CLAIMS: RequestClaims = { is_platform_admin: true, company_id: null, sub: "payroll-formula-spec-fixtures" };

/**
 * Payroll Formula Engine (0105_payroll_formulas.sql) — real Postgres, real
 * collaborators, no mocks (same rule as payroll.service.spec.ts). Uses its
 * OWN companies so nothing here can disturb payroll.service.spec.ts's
 * fixtures or numbers. The pure evaluator has its own spec
 * (formula-expression.engine.spec.ts).
 */
describe("Payroll formula overrides", () => {
  let pool: Pool;
  let db: DatabaseService;
  let formulaService: PayrollFormulaService;
  let overrides: PayrollFormulaOverridesService;
  let payroll: PayrollService;
  let payrollWithoutInjectedFormulas: PayrollService;
  let compensation: EmployeeCompensationService;

  let crudCompanyId: string;
  let crudHrClaims: RequestClaims;
  let crudNoPermissionClaims: RequestClaims;
  let calcCompanyId: string;
  let calcHrClaims: RequestClaims;
  let disabledCompanyClaims: RequestClaims;
  let disabledCompanyId: string;

  const stamp = Date.now();

  async function makeCompany(label: string, modules: string[]): Promise<string> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const company = await client.query("INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id", [
        `Payroll Formula Spec ${label} ${stamp}`,
        `payroll-formula-${label}-${stamp}`,
      ]);
      const id = company.rows[0].id as string;
      for (const m of modules) {
        await client.query("INSERT INTO tenant_module_entitlement (company_id, module_key, enabled) VALUES ($1, $2, true)", [id, m]);
      }
      return id;
    });
  }

  async function makeUserWithRole(label: string, roleKey: string | null, companyId: string): Promise<RequestClaims> {
    return db.withClaims(FIXTURE_CLAIMS, async (client) => {
      const user = await client.query("INSERT INTO user_accounts (email, password_hash) VALUES ($1, 'x') RETURNING id", [
        `payroll-formula-${label}-${stamp}@example.com`,
      ]);
      const userId = user.rows[0].id as string;
      if (roleKey) {
        const role = await client.query("SELECT id FROM roles WHERE key = $1", [roleKey]);
        await client.query("INSERT INTO user_role_assignments (user_account_id, company_id, role_id) VALUES ($1, $2, $3)", [
          userId,
          companyId,
          role.rows[0].id,
        ]);
      }
      return { is_platform_admin: false, company_id: companyId, sub: userId };
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    db = new DatabaseService(pool);
    const rbac = new RbacService(db);
    const entitlements = new EntitlementsService(db);
    const audit = new AuditService();
    const workflow = new WorkflowService(db, rbac, audit);
    const shifts = new ShiftsService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), new RulesEngine());
    const workSchedule = new WorkScheduleResolutionService(db, shifts, new HolidaysService(db, rbac, entitlements, audit));
    const employeeGroups = new EmployeeGroupsService(db, rbac, entitlements, new EffectiveDatingEngine(), new RulesEngine());
    const leaveRequests = new LeaveRequestsService(db, rbac, entitlements, audit, employeeGroups, workflow, workSchedule);
    const overtime = new OvertimeService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), workSchedule);
    formulaService = new PayrollFormulaService(new FormulaExpressionEngine());
    overrides = new PayrollFormulaOverridesService(db, rbac, entitlements, audit, new EffectiveDatingEngine(), formulaService);
    // Payroll Enterprise Gap Analysis Phase P3 (2026-10-02) — required
    // collaborator, same as leaveRequests/overtime/workSchedule above.
    const loans = new EmployeeLoansService(db, rbac, entitlements, audit);
    const additionalPayments = new EmployeeAdditionalPaymentsService(db, rbac, entitlements, audit);
    // Payroll Enterprise Gap Analysis Phase P4 (2026-10-02) — required
    // collaborator, same as loans/additionalPayments above.
    const offCyclePayments = new EmployeeOffCyclePaymentsService(db, rbac, entitlements, audit);
    const baseArgs = [db, rbac, entitlements, audit, new ImportExportService(), new EffectiveDatingEngine(), workflow, leaveRequests, overtime, workSchedule] as const;
    payroll = new PayrollService(...baseArgs, undefined, formulaService, loans, additionalPayments, offCyclePayments);
    payrollWithoutInjectedFormulas = new PayrollService(...baseArgs, undefined, undefined, loans, additionalPayments, offCyclePayments);
    compensation = new EmployeeCompensationService(db, rbac, entitlements, audit, new EffectiveDatingEngine());

    crudCompanyId = await makeCompany("crud", ["payroll"]);
    crudHrClaims = await makeUserWithRole("crud-hr", "hr_admin", crudCompanyId);
    crudNoPermissionClaims = await makeUserWithRole("crud-ess", "employee_self_service", crudCompanyId);

    calcCompanyId = await makeCompany("calc", ["employee", "payroll"]);
    calcHrClaims = await makeUserWithRole("calc-hr", "hr_admin", calcCompanyId);

    disabledCompanyId = await makeCompany("disabled", []);
    disabledCompanyClaims = await makeUserWithRole("disabled-hr", "hr_admin", disabledCompanyId);
  });

  afterAll(async () => {
    await db.withClaims(FIXTURE_CLAIMS, (client) =>
      client.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [[crudCompanyId, calcCompanyId, disabledCompanyId]])
    );
    await pool.end();
  });

  const EOBI_DOUBLE: PayrollFormulaExpression = { round: { value: { multiply: [{ var: "defaultAmount" }, { const: 2 }] }, places: 2 } };

  // --- CRUD --------------------------------------------------------------

  describe("permissions", () => {
    it("is gated by payroll.calculate.all (the tax-slab/settings permission) and the payroll module", async () => {
      await expect(overrides.list(crudNoPermissionClaims)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        overrides.create(crudNoPermissionClaims, { formulaKey: "eobi_employee", expression: { const: 1 } })
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(overrides.list(disabledCompanyClaims)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("create() validation", () => {
    it("rejects an unknown formula key, an unknown operator, a variable outside the key's contract, and a malformed node", async () => {
      await expect(
        overrides.create(crudHrClaims, { formulaKey: "gratuity" as never, expression: { const: 1 } })
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        overrides.create(crudHrClaims, { formulaKey: "eobi_employee", expression: { pow: [{ const: 2 }, { const: 2 }] } as never })
      ).rejects.toThrow(/Unknown formula operator "pow"/);
      // `taxableAnnualIncome` is an income_tax variable, not an EOBI one.
      await expect(
        overrides.create(crudHrClaims, { formulaKey: "eobi_employee", expression: { var: "taxableAnnualIncome" } })
      ).rejects.toThrow(/not available in this formula's context/);
      await expect(
        overrides.create(crudHrClaims, { formulaKey: "income_tax", expression: { add: [{ const: 1 }] } })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await overrides.list(crudHrClaims)).toEqual([]);
    });
  });

  describe("create / update / end-date lifecycle (effective-dated)", () => {
    let firstId: string;

    it("creates an open override", async () => {
      const created = await overrides.create(crudHrClaims, { formulaKey: "eobi_employee", expression: EOBI_DOUBLE, effectiveFrom: "2026-01-01" });
      firstId = created.id;
      expect(created).toMatchObject({ companyId: crudCompanyId, formulaKey: "eobi_employee", expression: EOBI_DOUBLE, effectiveFrom: "2026-01-01", effectiveTo: null });
    });

    it("refuses a second create while one is open (409) — supersede via update instead", async () => {
      await expect(
        overrides.create(crudHrClaims, { formulaKey: "eobi_employee", expression: { const: 1 }, effectiveFrom: "2026-03-01" })
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("update on the same effectiveFrom edits in place (same-day collapse)", async () => {
      const edited = await overrides.update(crudHrClaims, firstId, { expression: { const: 100 }, effectiveFrom: "2026-01-01" });
      expect(edited.id).toBe(firstId);
      expect(edited.expression).toEqual({ const: 100 });
      expect(await overrides.list(crudHrClaims, { formulaKey: "eobi_employee" })).toHaveLength(1);
    });

    it("update with a later effectiveFrom SUPERSEDES: closes the old one the day before, opens a new one", async () => {
      const next = await overrides.update(crudHrClaims, firstId, { expression: { const: 200 }, effectiveFrom: "2026-04-01" });
      expect(next.id).not.toBe(firstId);
      const history = await overrides.list(crudHrClaims, { formulaKey: "eobi_employee" });
      expect(history.map((h) => [h.effectiveFrom, h.effectiveTo, h.expression])).toEqual([
        ["2026-01-01", "2026-03-31", { const: 100 }],
        ["2026-04-01", null, { const: 200 }],
      ]);
    });

    it("refuses to supersede a closed generation, or to back-date before the open one's effectiveFrom", async () => {
      await expect(overrides.update(crudHrClaims, firstId, { expression: { const: 1 } })).rejects.toThrow(/currently-open/);
      const open = (await overrides.list(crudHrClaims, { formulaKey: "eobi_employee" })).find((h) => h.effectiveTo === null)!;
      await expect(
        overrides.update(crudHrClaims, open.id, { expression: { const: 1 }, effectiveFrom: "2026-03-15" })
      ).rejects.toThrow(/on or after/);
    });

    it("end-date closes the open override; a new one must start after it", async () => {
      const open = (await overrides.list(crudHrClaims, { formulaKey: "eobi_employee" })).find((h) => h.effectiveTo === null)!;
      await expect(overrides.endDate(crudHrClaims, open.id, { effectiveTo: "2026-03-31" })).rejects.toBeInstanceOf(BadRequestException);
      const ended = await overrides.endDate(crudHrClaims, open.id, { effectiveTo: "2026-06-30" });
      expect(ended.effectiveTo).toBe("2026-06-30");
      await expect(overrides.endDate(crudHrClaims, open.id, { effectiveTo: "2026-07-31" })).rejects.toThrow(/currently-open/);

      await expect(
        overrides.create(crudHrClaims, { formulaKey: "eobi_employee", expression: { const: 300 }, effectiveFrom: "2026-06-30" })
      ).rejects.toThrow(/must be after 2026-06-30/);
      const restarted = await overrides.create(crudHrClaims, { formulaKey: "eobi_employee", expression: { const: 300 }, effectiveFrom: "2026-08-01" });
      expect(restarted.effectiveTo).toBeNull();
    });

    it("unknown id -> 404; list filters by key and orders by key then effectiveFrom", async () => {
      await expect(overrides.update(crudHrClaims, "00000000-0000-0000-0000-000000000000", { expression: { const: 1 } })).rejects.toBeInstanceOf(
        NotFoundException
      );
      await overrides.create(crudHrClaims, { formulaKey: "income_tax", expression: { var: "defaultAmount" }, effectiveFrom: "2026-01-01" });
      const all = await overrides.list(crudHrClaims);
      expect(all.map((f) => f.formulaKey)).toEqual(["eobi_employee", "eobi_employee", "eobi_employee", "income_tax"]);
      expect(await overrides.list(crudHrClaims, { formulaKey: "eobi_employer" })).toEqual([]);
      await expect(overrides.list(crudHrClaims, { formulaKey: "nope" })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("resolveAndEvaluate(): the override in force on the as-of date, or null (= fall back) outside every range", async () => {
      const ctx = { defaultAmount: 407, wageBase: 40700, ratePercent: 1, paidDays: 31, employmentWindowDays: 31, paidDaysRatio: 1, grossPay: 150000 };
      const at = (date: string) =>
        db.withClaims(crudHrClaims, (client) => formulaService.resolveAndEvaluate(client, crudCompanyId, "eobi_employee", date, ctx));
      expect(await at("2025-12-31")).toBeNull(); // before the first generation
      expect((await at("2026-01-01"))!.value).toBe(100);
      expect((await at("2026-03-31"))!.value).toBe(100); // inclusive end
      expect((await at("2026-04-01"))!.value).toBe(200);
      expect((await at("2026-06-30"))!.value).toBe(200);
      expect(await at("2026-07-15")).toBeNull(); // the end-dated gap
      expect(await at("2026-08-01")).toMatchObject({ value: 300, effectiveFrom: "2026-08-01" });
      // A key with no override at all -> null.
      const employer = await db.withClaims(crudHrClaims, (client) =>
        formulaService.resolveAndEvaluate(client, crudCompanyId, "eobi_employer", "2026-08-01", ctx)
      );
      expect(employer).toBeNull();
    });

    it("RLS: another tenant never sees, or resolves, these overrides", async () => {
      expect(await overrides.list(calcHrClaims)).toEqual([]);
      const leaked = await db.withClaims(calcHrClaims, (client) =>
        formulaService.resolveAndEvaluate(client, crudCompanyId, "eobi_employee", "2026-08-01", {
          defaultAmount: 1, wageBase: 1, ratePercent: 1, paidDays: 1, employmentWindowDays: 1, paidDaysRatio: 1, grossPay: 1,
        })
      );
      expect(leaked).toBeNull();
    });
  });

  describe("getContract()", () => {
    it("documents exactly the variables each key exposes", async () => {
      const contract = await overrides.getContract(crudHrClaims);
      const names = Object.fromEntries(contract.map((c) => [c.formulaKey, c.variables.map((v) => v.name)]));
      expect(names.eobi_employee).toEqual(["defaultAmount", "wageBase", "ratePercent", "paidDays", "employmentWindowDays", "paidDaysRatio", "grossPay"]);
      expect(names.eobi_employer).toEqual(names.eobi_employee);
      expect(names.income_tax).toEqual([
        "defaultAmount",
        "grossPay",
        "taxableGrossThisPeriod",
        "recurringTaxableThisPeriod",
        "overtimePay",
        "taxableAnnualIncome",
        "priorYtdTaxableIncome",
        "priorYtdTaxWithheld",
        "slabAnnualTax",
        "taxDueToDate",
        "bracketMinAnnualIncome",
        "bracketBaseTax",
        "bracketRatePercent",
        "daysInPeriod",
        "taxYearDaysElapsed",
        "taxYearTotalDays",
        "taxYearFractionElapsed",
      ]);
      expect(contract.every((c) => c.variables.every((v) => v.description.length > 0))).toBe(true);
    });
  });

  describe("CreatePayrollFormulaDto under the app's global ValidationPipe", () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    it("passes a nested expression through intact and rejects a bad key / non-object expression", async () => {
      const body = { formulaKey: "eobi_employee", effectiveFrom: "2026-07-01", expression: EOBI_DOUBLE };
      const out = await pipe.transform(body, { type: "body", metatype: CreatePayrollFormulaDto });
      expect(JSON.parse(JSON.stringify(out.expression))).toEqual(EOBI_DOUBLE);
      await expect(pipe.transform({ ...body, formulaKey: "nope" }, { type: "body", metatype: CreatePayrollFormulaDto })).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(pipe.transform({ ...body, expression: "1+1" }, { type: "body", metatype: CreatePayrollFormulaDto })).rejects.toBeInstanceOf(
        BadRequestException
      );
    });
  });

  // --- calculateRun() integration ------------------------------------------

  describe("calculateRun() with overrides", () => {
    let employeeId: string;
    let julyRunId: string;
    let augRunId: string;
    let baselineJuly: PayslipView;
    let baselineAug: PayslipView;

    const payslipFor = async (runId: string): Promise<PayslipView> => {
      const slips = await payroll.listPayslips(calcHrClaims, { payrollRunId: runId });
      expect(slips).toHaveLength(1);
      return slips[0];
    };
    const comparable = (p: PayslipView) => {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = p;
      return rest;
    };

    beforeAll(async () => {
      employeeId = await db.withClaims(FIXTURE_CLAIMS, async (client) => {
        const r = await client.query(
          `INSERT INTO employees (company_id, employee_number, first_name, last_name, date_of_joining)
           VALUES ($1, 'PF-1', 'Formula', 'Employee', '2020-01-01') RETURNING id`,
          [calcCompanyId]
        );
        return r.rows[0].id as string;
      });
      await compensation.setCompensation(calcHrClaims, { employeeId, monthlySalary: 250000, effectiveFrom: "2020-01-01" });

      julyRunId = (await payroll.createRun(calcHrClaims, { periodStart: "2026-07-01", periodEnd: "2026-07-31" })).id;
      augRunId = (await payroll.createRun(calcHrClaims, { periodStart: "2026-08-01", periodEnd: "2026-08-31" })).id;
      // Baselines: no override exists yet -> pure built-in calculation.
      await payroll.calculateRun(calcHrClaims, julyRunId);
      await payroll.calculateRun(calcHrClaims, augRunId);
      baselineJuly = await payslipFor(julyRunId);
      baselineAug = await payslipFor(augRunId);
      expect(baselineAug.incomeTaxMonthly).toBeGreaterThan(100);

      await overrides.create(calcHrClaims, { formulaKey: "eobi_employee", expression: EOBI_DOUBLE, effectiveFrom: "2026-08-01" });
      await overrides.create(calcHrClaims, { formulaKey: "eobi_employer", expression: { const: 1234.5 }, effectiveFrom: "2026-08-01" });
      await overrides.create(calcHrClaims, {
        formulaKey: "income_tax",
        expression: { max: [{ const: 0 }, { subtract: [{ var: "defaultAmount" }, { const: 100 }] }] },
        effectiveFrom: "2026-08-01",
      });
    });

    it("a run whose periodEnd is before every override's effectiveFrom is byte-identical to the built-in result", async () => {
      await payroll.calculateRun(calcHrClaims, julyRunId);
      expect(comparable(await payslipFor(julyRunId))).toEqual(comparable(baselineJuly));
    });

    it("a run inside the overrides' range uses all three formula results, and net pay follows them", async () => {
      await payroll.calculateRun(calcHrClaims, augRunId);
      const slip = await payslipFor(augRunId);
      // Gross side untouched.
      expect(slip.grossPay).toBe(baselineAug.grossPay);
      expect(slip.taxableAnnualIncome).toBe(baselineAug.taxableAnnualIncome);
      // The three overridden figures.
      expect(slip.eobiEmployeeContribution).toBeCloseTo(baselineAug.eobiEmployeeContribution * 2, 1);
      expect(slip.eobiEmployerContribution).toBe(1234.5);
      expect(slip.incomeTaxMonthly).toBeCloseTo(baselineAug.incomeTaxMonthly - 100, 1);
      expect(slip.netPay).toBeCloseTo(slip.grossPay - slip.incomeTaxMonthly - slip.eobiEmployeeContribution, 1);
      // Every overridden line says so (with the built-in figure alongside) for the accountant reviewing it.
      const overrideLines = slip.calculationBreakdown.filter((s) => s.label.includes("tenant formula override effective 2026-08-01"));
      expect(overrideLines.map((s) => s.label.split(" — ")[0])).toEqual([
        "Income tax this period",
        "EOBI employee contribution",
        "EOBI employer contribution",
      ]);
      expect(overrideLines[0].label).toContain(`built-in calculation: ${baselineAug.incomeTaxMonthly.toFixed(2)}`);
    });

    it("applies configured overrides even when PayrollService was hand-constructed without a PayrollFormulaService", async () => {
      await payrollWithoutInjectedFormulas.calculateRun(calcHrClaims, augRunId);
      expect((await payslipFor(augRunId)).eobiEmployerContribution).toBe(1234.5);
    });

    it("a configured override that fails at evaluation is a loud per-employee error, never a silent fallback", async () => {
      const employer = (await overrides.list(calcHrClaims, { formulaKey: "eobi_employer" }))[0];
      // paidDays - paidDays = 0 -> division by zero, only knowable at evaluation time.
      await overrides.update(calcHrClaims, employer.id, {
        expression: { divide: [{ var: "defaultAmount" }, { subtract: [{ var: "paidDays" }, { var: "paidDays" }] }] },
        effectiveFrom: "2026-09-01",
      });
      const sepRun = await payroll.createRun(calcHrClaims, { periodStart: "2026-09-01", periodEnd: "2026-09-30" });
      const result = await payroll.calculateRun(calcHrClaims, sepRun.id);
      expect(result.payslipCount).toBe(0);
      expect(result.errors).toEqual([{ employeeId, message: expect.stringMatching(/"eobi_employer".*effective from 2026-09-01.*"divide" by zero/) }]);

      // ...while August still resolves the generation in force at ITS periodEnd.
      await payroll.calculateRun(calcHrClaims, augRunId);
      expect((await payslipFor(augRunId)).eobiEmployerContribution).toBe(1234.5);
    });

    it("a negative formula result is rejected rather than silently increasing net pay", async () => {
      const employee = (await overrides.list(calcHrClaims, { formulaKey: "eobi_employee" }))[0];
      await overrides.update(calcHrClaims, employee.id, {
        expression: { subtract: [{ const: 0 }, { var: "defaultAmount" }] },
        effectiveFrom: "2026-10-01",
      });
      const octRun = await payroll.createRun(calcHrClaims, { periodStart: "2026-10-01", periodEnd: "2026-10-31" });
      const result = await payroll.calculateRun(calcHrClaims, octRun.id);
      expect(result.payslipCount).toBe(0);
      expect(result.errors[0].message).toMatch(/"eobi_employee".*negative amount/);
    });

    it("end-dating every override returns later runs to the built-in calculation", async () => {
      for (const f of await overrides.list(calcHrClaims)) {
        if (f.effectiveTo === null) await overrides.endDate(calcHrClaims, f.id, { effectiveTo: f.effectiveFrom > "2026-08-31" ? f.effectiveFrom : "2026-08-31" });
      }
      const novRun = await payroll.createRun(calcHrClaims, { periodStart: "2026-11-01", periodEnd: "2026-11-30" });
      const result = await payroll.calculateRun(calcHrClaims, novRun.id);
      expect(result.errors).toEqual([]);
      const slip = await payslipFor(novRun.id);
      expect(slip.calculationBreakdown.some((s) => s.label.includes("tenant formula override"))).toBe(false);
      expect(slip.eobiEmployerContribution).toBe(baselineAug.eobiEmployerContribution);
    });
  });
});
