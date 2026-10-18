/**
 * Loads a fresh, consistent demo data set into ONE company, through the application's own services (so every business rule,
 * numbering, person record, org assignment, audit entry and approval rule runs exactly as it does for a real user):
 * sites, org units, jobs, cost/profit centers, positions with a head per department, 40 employees with managers, salaries,
 * bank accounts, checklists and the other modules' sample records.
 *
 * Run it after reset-tenant-data.ts (it refuses to run when the company still has employees):
 *   npm run seed-demo -- --slug qatar-solutions
 *
 * Every step logs what it created and the first error stops the run with the step's name, so a gap in the product shows up
 * as a clear message instead of half-loaded data.
 */

import { join } from "path";
import "reflect-metadata";
import { loadEnvFile } from "../load-env";
import type { INestApplicationContext } from "@nestjs/common";
import type { RequestClaims } from "./tenant-context";
import {
  DEMO_EMPLOYEES,
  DEMO_JOBS,
  DEMO_LOCATIONS,
  DEMO_UNITS,
  demoCnic,
  demoEmail,
  demoIban,
  demoPhone,
  DEMO_CANDIDATES,
  DEMO_COMPETENCIES,
  DEMO_COURSES,
  DEMO_EXPENSES,
  DEMO_GOALS,
  DEMO_LEAVE_POLICIES,
  DEMO_ONBOARDING,
  DEMO_OFFBOARDING,
  DEMO_REQUISITIONS,
} from "./demo-tenant-data";

export type SeedLog = (line: string) => void;
export type SeedResult = { counts: Record<string, number>; hrAdminEmployeeId: string | null; warnings: string[] };

type Svc<T> = new (...args: never[]) => T;

async function step<T>(log: SeedLog, name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Seed step "${name}" failed: ${msg}`);
  }
}

/** The company's own HR admin account: the actor of every write (so the audit trail names a real login). */
const SERVICE_CLAIMS: RequestClaims = { is_platform_admin: false, is_service: true, sub: "seed-tenant-demo" };

async function findAdminUser(app: INestApplicationContext, companyId: string): Promise<{ id: string; email: string }> {
  const { DatabaseService } = await import("./database.service");
  const db = app.get(DatabaseService, { strict: false });
  const r = await db.withClaims(SERVICE_CLAIMS, (c) => c.query(
    `SELECT u.id, u.email
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
       JOIN user_accounts u ON u.id = ura.user_account_id
      WHERE ura.company_id = $1 AND r.key = 'hr_admin'
      ORDER BY (SELECT count(*) FROM user_role_assignments x WHERE x.user_account_id = u.id AND x.company_id = $1) DESC, u.created_at
      LIMIT 1`,
    [companyId]
  ));
  if (r.rowCount === 0) throw new Error("This company has no login with the hr_admin role to act as");
  return r.rows[0] as { id: string; email: string };
}

/**
 * The people's CNIC, phone and bank details are stored encrypted with the company's own key, which is itself locked with the
 * master key FIELD_ENCRYPTION_KEY. If this machine's .env does not hold the SAME master key as the live API (Render), nothing
 * sensitive can be written. That is checked first, before anything is created (and, in the PowerShell script, before anything is deleted).
 */
export async function checkFieldKeys(app: INestApplicationContext, companyId: string, claims: RequestClaims): Promise<void> {
  const { DatabaseService } = await import("./database.service");
  const { fieldCrypto } = await import("../crypto/field-crypto");
  const db = app.get(DatabaseService, { strict: false });
  try {
    await db.withClaims(claims, async (client) => {
      await fieldCrypto.warm(client, companyId);
    });
  } catch (err) {
    throw new Error(
      `Encryption key problem: ${(err as Error).message}. FIELD_ENCRYPTION_KEY in apps\\api\\.env must be exactly the same value as FIELD_ENCRYPTION_KEY on Render (api service > Environment). Copy it from there into .env, then run again.`
    );
  }
  if (!fieldCrypto.isWarm(companyId)) throw new Error("Encryption key problem: this company's keys could not be loaded. Check FIELD_ENCRYPTION_KEY in apps\\api\\.env (it must match Render).");
}

export async function seedDemoTenant(app: INestApplicationContext, companyId: string, log: SeedLog = console.log): Promise<SeedResult> {
  const { DatabaseService } = await import("./database.service");
  const { OrgUnitsService } = await import("../organization/org-units.service");
  const { LocationsService } = await import("../organization/locations.service");
  const { JobsService } = await import("../organization/jobs.service");
  const { PositionsService } = await import("../organization/positions.service");
  const { CostCentersService } = await import("../organization/cost-centers.service");
  const { ProfitCentersService } = await import("../organization/profit-centers.service");
  const { EmployeesService } = await import("../employees/employees.service");
  const { EmployeeCompensationService } = await import("../employees/employee-compensation.service");
  const { EmployeePaymentAccountsService } = await import("../employees/employee-payment-accounts.service");

  const get = <T>(cls: Svc<T>): T => app.get(cls as never, { strict: false }) as T;
  const db = get(DatabaseService);
  const units = get(OrgUnitsService);
  const locations = get(LocationsService);
  const jobs = get(JobsService);
  const positions = get(PositionsService);
  const costCenters = get(CostCentersService);
  const profitCenters = get(ProfitCentersService);
  const employees = get(EmployeesService);
  const compensation = get(EmployeeCompensationService);
  const paymentAccounts = get(EmployeePaymentAccountsService);

  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

  const existing = await db.withClaims(SERVICE_CLAIMS, (c) =>
    c.query("SELECT count(*)::int AS n FROM employees WHERE company_id = $1", [companyId])
  );
  if (existing.rows[0].n > 0) throw new Error(`The company still has ${existing.rows[0].n} employees. Run the reset first (npm run reset-tenant).`);

  const admin = await findAdminUser(app, companyId);
  const claims: RequestClaims = { is_platform_admin: false, company_id: companyId, sub: admin.id };
  log(`Acting as ${admin.email}`);
  await checkFieldKeys(app, companyId, claims);

  // ---- sites ------------------------------------------------------------
  const locationId: Record<string, string> = {};
  await step(log, "locations", async () => {
    for (const l of DEMO_LOCATIONS) {
      const created = await locations.create(claims, {
        parentId: l.parent ? locationId[l.parent] : undefined,
        locationType: l.type,
        code: l.code,
        name: l.name,
        address: l.address,
      });
      locationId[l.key] = created.id;
      bump("locations");
    }
  });
  log(`locations: ${counts.locations}`);

  // ---- organization units ----------------------------------------------
  const unitId: Record<string, string> = {};
  await step(log, "org units", async () => {
    for (const u of DEMO_UNITS) {
      const created = await units.create(claims, { name: u.name, unitType: u.type, code: u.code, parentId: u.parent ? unitId[u.parent] : undefined });
      unitId[u.key] = created.id;
      bump("orgUnits");
    }
  });
  log(`org units: ${counts.orgUnits}`);

  // ---- cost and profit centers -----------------------------------------
  const costCenterId: Record<string, string> = {};
  await step(log, "cost centers", async () => {
    for (const u of DEMO_UNITS.filter((x) => x.key !== "root")) {
      const cc = await costCenters.create(claims, { code: `CC-${u.code}`, name: `${u.name} cost center`, orgUnitId: unitId[u.key] });
      costCenterId[u.key] = cc.id;
      bump("costCenters");
    }
    await profitCenters.create(claims, { code: "PC-PK", name: "Pakistan operations", orgUnitId: unitId.root });
    bump("profitCenters");
  });
  log(`cost centers: ${counts.costCenters}, profit centers: ${counts.profitCenters}`);

  // ---- jobs ---------------------------------------------------------------
  const jobId: Record<string, string> = {};
  await step(log, "jobs", async () => {
    for (const j of DEMO_JOBS) {
      const created = await jobs.create(claims, { title: j.title, jobCode: j.code, jobFamily: j.family as never, jobLevel: j.level });
      jobId[j.title] = created.id;
      bump("jobs");
    }
  });
  log(`jobs: ${counts.jobs}`);

  // ---- employees (managers first), then seats ----------------------------
  const employeeId: Record<string, string> = {};
  const positionId: Record<string, string> = {};
  let hrAdminEmployeeId: string | null = null;
  // The list is written managers-first (numbers then follow the list: the CEO is EMP-0001); a manager listed after
  // their report would have no id yet, so that is checked here instead of failing later with a confusing message.
  const ordered = DEMO_EMPLOYEES;
  DEMO_EMPLOYEES.forEach((e, i) => {
    if (e.manager && DEMO_EMPLOYEES.findIndex((m) => m.key === e.manager) >= i) throw new Error(`Demo data error: ${e.key} is listed before their manager ${e.manager}`);
  });

  await step(log, "employees", async () => {
    for (const e of ordered) {
      const i = DEMO_EMPLOYEES.indexOf(e) + 1;
      const created = await employees.create(claims, {
        firstName: e.first,
        lastName: e.last,
        email: demoEmail(e),
        phone: demoPhone(i),
        cnic: demoCnic(i),
        dateOfBirth: e.dob,
        gender: e.gender,
        maritalStatus: e.marital,
        orgUnitId: unitId[e.unit],
        designation: e.job,
        locationId: locationId[e.site],
        employmentType: e.type,
        managerId: e.manager ? employeeId[e.manager] : undefined,
        dateOfJoining: e.joined,
        // the HR manager record is the company admin's own employee record, so that login has a person behind it
        userAccountId: e.key === "hrm" ? admin.id : undefined,
      });
      employeeId[e.key] = created.id;
      if (e.key === "hrm") hrAdminEmployeeId = created.id;
      bump("employees");
    }
  });
  log(`employees: ${counts.employees}`);

  await step(log, "positions", async () => {
    for (const e of ordered) {
      const position = await positions.create(claims, {
        orgUnitId: unitId[e.unit],
        jobId: jobId[e.job],
        costCenterId: costCenterId[e.unit],
        positionTitle: e.job,
        positionCode: `P-${e.key.toUpperCase()}`,
        headcountFte: 1,
        effectiveFrom: e.joined,
      });
      positionId[e.key] = position.id;
      bump("positions");
      await positions.assignEmployee(claims, position.id, employeeId[e.key], e.joined);
      bump("seatsFilled");
    }
    for (const e of DEMO_EMPLOYEES.filter((x) => x.head)) {
      await units.setHeadPosition(claims, unitId[e.unit], { positionId: positionId[e.key] });
      bump("headPositions");
    }
  });
  log(`positions: ${counts.positions}, filled: ${counts.seatsFilled}, department heads: ${counts.headPositions}`);

  // ---- pay: salary and a bank account for everyone ------------------------
  await step(log, "compensation", async () => {
    for (const e of DEMO_EMPLOYEES) {
      await compensation.setCompensation(claims, { employeeId: employeeId[e.key], monthlySalary: e.salary, effectiveFrom: e.joined });
      bump("compensation");
    }
  });
  log(`salaries: ${counts.compensation}`);

  await step(log, "payment accounts", async () => {
    const BANK_CODES: Record<string, string> = { "Meezan Bank": "MEZN", HBL: "HABB", UBL: "UNIL", "Bank Alfalah": "ALFH", MCB: "MUCB" };
    for (const e of DEMO_EMPLOYEES) {
      const i = DEMO_EMPLOYEES.indexOf(e) + 1;
      await paymentAccounts.create(claims, {
        employeeId: employeeId[e.key],
        paymentMethod: "bank_transfer" as never,
        bankName: e.bank,
        accountTitle: `${e.first} ${e.last}`,
        iban: demoIban(i, BANK_CODES[e.bank] ?? "MUCB"),
        isPrimary: true,
        validFrom: e.joined,
        currency: "PKR",
      });
      bump("paymentAccounts");
    }
  });
  log(`bank accounts: ${counts.paymentAccounts}`);

  // =====================================================================================================================
  // The other modules. Each block is its own step: a module that is switched off or not configured for this company is
  // reported as a warning and the rest of the data still loads (the people and structure above are the part that matters).
  // =====================================================================================================================
  const warnings: string[] = [];
  const optional = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      const msg = `${name}: ${err instanceof Error ? err.message : String(err)}`;
      warnings.push(msg);
      log(`WARNING - ${msg}`);
    }
  };
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> => {
    const r = await db.withClaims(claims, (c) => c.query(sql, params));
    return (r.rows[0] as T | undefined) ?? null;
  };
  const today = new Date().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const unitOf = (key: string) => DEMO_EMPLOYEES.find((x) => x.key === key)!.unit;

  // ---- the starter setup: approval routes, Pakistan public holidays, a default leave policy and shift (only what is missing) ----
  await optional("starter setup", async () => {
    const { StarterSetupService } = await import("../starter-setup/starter-setup.service");
    const result = await get(StarterSetupService).apply(claims);
    bump("starterSetupCreated", result.created.length);
    log(`starter setup: created ${result.created.join(", ") || "nothing"}; already there ${result.skipped.join(", ") || "nothing"}`);
  });

  // ---- onboarding and offboarding checklists ------------------------------------------------------------------------
  await optional("checklists", async () => {
    const { OnboardingService } = await import("../onboarding-offboarding/onboarding.service");
    const { OffboardingService } = await import("../onboarding-offboarding/offboarding.service");
    const onboarding = get(OnboardingService);
    const offboarding = get(OffboardingService);
    // checklist definitions are company configuration and survive the reset: load them only when the company has none
    if (((await one<{ n: number }>("SELECT count(*)::int AS n FROM onboarding_item_templates WHERE company_id = $1", [companyId]))?.n ?? 0) === 0) {
      let i = 0;
      for (const t of DEMO_ONBOARDING) {
        await onboarding.createItemTemplate(claims, {
          title: t.title,
          category: t.category,
          responsibleRole: t.role,
          sortOrder: ++i * 10,
          dueOffsetDays: t.days ?? null,
          assigneeRule: t.role === "self" ? "employee" : "none",
        });
        bump("onboardingItems");
      }
    }
    if (((await one<{ n: number }>("SELECT count(*)::int AS n FROM offboarding_item_templates WHERE company_id = $1", [companyId]))?.n ?? 0) === 0) {
      let i = 0;
      for (const t of DEMO_OFFBOARDING) {
        await offboarding.createItemTemplate(claims, { title: t.title, category: t.category, responsibleRole: t.role, sortOrder: ++i * 10 });
        bump("offboardingItems");
      }
    }
  });
  log(`checklist items: onboarding ${counts.onboardingItems ?? 0}, offboarding ${counts.offboardingItems ?? 0}`);

  // ---- leave: groups, policies, balances ------------------------------------------------------------------------------
  await optional("leave policies and balances", async () => {
    const { EmployeeGroupsService } = await import("../employee-groups/employee-groups.service");
    const { LeaveLedgerService } = await import("../leave/leave-ledger.service");
    const { resolveEntitlement } = await import("../leave/leave-entitlements.repo");
    const groups = get(EmployeeGroupsService);
    const ledger = get(LeaveLedgerService);
    const hasDefault = ((await one<{ n: number }>("SELECT count(*)::int AS n FROM leave_policies WHERE company_id = $1 AND is_default", [companyId]))?.n ?? 0) > 0;

    const policyIdByKey: Record<string, string> = {};
    for (const [key, p] of Object.entries(DEMO_LEAVE_POLICIES)) {
      const found = await one<{ id: string }>("SELECT id FROM leave_policies WHERE company_id = $1 AND name = $2", [companyId, p.name]);
      if (found) {
        policyIdByKey[key] = found.id;
        continue;
      }
      const created = await groups.createLeavePolicy(claims, {
        name: p.name,
        annualLeaveDays: p.annual,
        casualLeaveDays: p.casual,
        sickLeaveDays: p.sick,
        isDefault: p.isDefault && !hasDefault,
      });
      policyIdByKey[key] = created.id;
      bump("leavePolicies");
    }
    for (const [key, employmentType] of [["permanent", "permanent"], ["contract", "contract"]] as const) {
      const name = DEMO_LEAVE_POLICIES[key].name;
      let group = await one<{ id: string }>("SELECT id FROM employee_groups WHERE company_id = $1 AND name = $2", [companyId, name]);
      if (!group) {
        const created = await groups.createGroup(claims, { name, description: `Everyone on a ${employmentType} contract`, conditions: [{ field: "employmentType", equals: employmentType }] });
        group = { id: created.id };
        bump("employeeGroups");
        await groups.assignPolicy(claims, group.id, { policyType: "leave", policyId: policyIdByKey[key], effectiveFrom: `${year}-01-01` });
      }
    }
    // balances for the current year, from whatever policy each person resolves to
    for (const e of DEMO_EMPLOYEES) {
      const resolved = await groups.resolvePolicyInternal(claims, employeeId[e.key], "leave");
      if (!resolved?.policyId) continue;
      await db.withClaims(claims, async (client) => {
        for (const code of ["annual", "casual", "sick"]) {
          const ent = await resolveEntitlement(client, resolved.policyId as string, code);
          if (!ent || ent.days <= 0) continue;
          await ledger.ensureBalance(client, companyId, employeeId[e.key], code, year, { days: ent.days, method: "upfront" }, today);
          bump("leaveBalances");
        }
      });
    }
  });
  log(`leave: ${counts.leavePolicies ?? 0} new policies, ${counts.employeeGroups ?? 0} new groups, ${counts.leaveBalances ?? 0} balances`);

  // ---- attendance: work schedules and who works which ------------------------------------------------------------------
  await optional("work schedules", async () => {
    const { ShiftsService } = await import("../shifts/shifts.service");
    const shifts = get(ShiftsService);
    const anyDefault = ((await one<{ n: number }>("SELECT count(*)::int AS n FROM shifts WHERE company_id = $1 AND is_default", [companyId]))?.n ?? 0) > 0;
    const ensureShift = async (name: string, start: string, end: string, workingDays: number[], isDefault: boolean) => {
      const found = await one<{ id: string }>("SELECT id FROM shifts WHERE company_id = $1 AND name = $2", [companyId, name]);
      if (found) return found.id;
      const created = await shifts.createShift(claims, { name, startTime: start, endTime: end, graceMinutesLate: 15, isDefault });
      await shifts.setWeeklyPattern(claims, created.id, {
        days: [0, 1, 2, 3, 4, 5, 6].map((d) => (workingDays.includes(d) ? { dayOfWeek: d, isWorking: true, startTime: start, endTime: end } : { dayOfWeek: d, isWorking: false })),
      });
      bump("shifts");
      return created.id;
    };
    const office = await ensureShift("Office Hours (Mon-Fri)", "09:00", "18:00", [1, 2, 3, 4, 5], !anyDefault);
    const operations = await ensureShift("Operations Shift (Mon-Sat)", "08:00", "17:00", [1, 2, 3, 4, 5, 6], false);
    for (const e of DEMO_EMPLOYEES) {
      await shifts.assignShift(claims, { employeeId: employeeId[e.key], shiftId: e.unit === "ops" ? operations : office, effectiveFrom: e.joined });
      bump("shiftAssignments");
    }
  });
  log(`work schedules: ${counts.shifts ?? 0} new, ${counts.shiftAssignments ?? 0} assignments`);

  // ---- learning: courses, enrolments, competencies --------------------------------------------------------------------
  await optional("learning", async () => {
    const { CoursesService } = await import("../learning/courses.service");
    const { CourseEnrollmentsService } = await import("../learning/course-enrollments.service");
    const courses = get(CoursesService);
    const enrollments = get(CourseEnrollmentsService);
    for (const c of DEMO_COURSES) {
      const course = await courses.create(claims, { title: c.title, description: c.description, category: c.category, durationMinutes: c.minutes });
      bump("courses");
      for (const e of DEMO_EMPLOYEES) {
        if (!c.everyone && !(c.units ?? []).includes(e.unit)) continue;
        await enrollments.enroll(claims, { employeeId: employeeId[e.key], courseId: course.id, dueDate: `${year}-12-31` });
        bump("courseEnrollments");
      }
    }
  });
  log(`learning: ${counts.courses ?? 0} courses, ${counts.courseEnrollments ?? 0} enrolments`);

  // ---- performance: competencies, a review cycle, goals, development plans ----------------------------------------------
  await optional("performance", async () => {
    const { PerformanceService } = await import("../performance/performance.service");
    const { PerformanceDepthService } = await import("../performance/performance-depth.service");
    const performance = get(PerformanceService);
    const depth = get(PerformanceDepthService);
    for (const c of DEMO_COMPETENCIES) {
      await depth.createCompetency(claims, c);
      bump("competencies");
    }
    const cycleName = `Annual Performance Review ${year}`;
    const found = await one<{ id: string }>("SELECT id FROM review_cycles WHERE company_id = $1 AND name = $2", [companyId, cycleName]);
    const cycle = found ?? (await performance.createCycle(claims, { name: cycleName, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` }));
    if (!found) bump("reviewCycles");
    for (const e of DEMO_EMPLOYEES) {
      for (const g of DEMO_GOALS) {
        if (!g.units.includes(e.unit)) continue;
        await performance.createGoal(claims, {
          reviewCycleId: cycle.id,
          employeeId: employeeId[e.key],
          title: g.title,
          description: g.description,
          weight: g.weight,
          dueDate: `${year}-12-15`,
          targetValue: g.target,
          targetUnit: g.unit,
        });
        bump("goals");
      }
    }
    // development plans for the department heads
    for (const e of DEMO_EMPLOYEES.filter((x) => x.head && x.key !== "ceo")) {
      await depth.createPlan(claims, {
        employeeId: employeeId[e.key],
        title: `Leadership development for ${e.first} ${e.last}`,
        objective: "Prepare for a wider role: coaching the team, budgeting and cross-department planning.",
        targetDate: `${year + 1}-06-30`,
      });
      bump("developmentPlans");
    }
  });
  log(`performance: ${counts.competencies ?? 0} competencies, ${counts.reviewCycles ?? 0} cycle, ${counts.goals ?? 0} goals, ${counts.developmentPlans ?? 0} development plans`);

  // ---- recruitment: three open requisitions with candidates in the pipeline ----------------------------------------------
  await optional("recruitment", async () => {
    const { RecruitmentService } = await import("../recruitment/recruitment.service");
    const recruitment = get(RecruitmentService);
    const requisitionIds: string[] = [];
    for (const r of DEMO_REQUISITIONS) {
      let req = await recruitment.createRequisition(claims, {
        title: r.title,
        headcount: r.headcount,
        salaryBand: r.band,
        justification: r.why,
        hiringManagerId: employeeId[r.manager],
        orgUnitId: unitId[r.unit],
        jobId: jobId[r.job],
        locationId: locationId[r.site],
      });
      bump("requisitions");
      req = await recruitment.submitRequisition(claims, req.id);
      if (req.status === "pending_approval") req = await recruitment.decideRequisition(claims, req.id, { decision: "approved", comment: "Approved in the annual hiring plan" });
      if (req.status === "approved") req = await recruitment.applyRequisitionAction(claims, req.id, "open");
      requisitionIds.push(req.id);
    }
    const ladder = ["applied", "screening", "interview"] as const;
    for (const [i, c] of DEMO_CANDIDATES.entries()) {
      const candidate = await recruitment.createCandidate(claims, {
        firstName: c.first,
        lastName: c.last,
        email: `${c.first}.${c.last}@candidates.example`.toLowerCase(),
        phone: demoPhone(100 + i),
        source: c.source,
        currentEmployer: c.employer,
        currentDesignation: c.designation,
        expectedSalary: c.expected,
        noticePeriodDays: c.notice,
        consentGiven: true,
        consentPurpose: "Considering the applicant for open roles",
      });
      bump("candidates");
      const application = await recruitment.createApplication(claims, { requisitionId: requisitionIds[c.requisition], candidateId: candidate.id, source: c.source });
      bump("applications");
      const target = c.stage === "rejected" ? "screening" : c.stage;
      for (const stage of ladder.slice(1, ladder.indexOf(target as (typeof ladder)[number]) + 1)) {
        await recruitment.moveApplicationStage(claims, application.id, stage);
      }
      if (c.stage === "rejected") await recruitment.moveApplicationStage(claims, application.id, "rejected", c.reason ?? "Not selected");
    }
  });
  log(`recruitment: ${counts.requisitions ?? 0} requisitions, ${counts.candidates ?? 0} candidates, ${counts.applications ?? 0} applications`);

  // ---- expenses: the HR manager's own claims (the only demo person with a login) -----------------------------------------
  await optional("expense claims", async () => {
    const { ExpenseClaimsService } = await import("../expenses/expense-claims.service");
    const expenses = get(ExpenseClaimsService);
    for (const x of DEMO_EXPENSES) {
      await expenses.submit(claims, { employeeId: employeeId.hrm, category: x.category, expenseDate: x.date, amount: x.amount, description: x.description });
      bump("expenseClaims");
    }
  });
  log(`expense claims: ${counts.expenseClaims ?? 0}`);

  // ---- payroll: last month's run, calculated and left for review ----------------------------------------------------------
  await optional("payroll run", async () => {
    const { PayrollService } = await import("../payroll/payroll.service");
    const payroll = get(PayrollService);
    const prev = new Date(Date.UTC(year, Number(today.slice(5, 7)) - 2, 1));
    const start = prev.toISOString().slice(0, 10);
    const end = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const run = await payroll.createRun(claims, { periodStart: start, periodEnd: end });
    await payroll.calculateRun(claims, run.id);
    bump("payrollRuns");
  });
  log(`payroll runs: ${counts.payrollRuns ?? 0}`);

  if (warnings.length > 0) log(`${warnings.length} optional step(s) did not load - see WARNING lines above`);

  return { counts, hrAdminEmployeeId, warnings };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  loadEnvFile(join(__dirname, "../../.env"));
  const slug = arg("slug");
  if (!slug) throw new Error("Give the company with --slug <company-slug>");
  const { NestFactory } = await import("@nestjs/core");
  const { AppModule } = await import("../app.module");
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  try {
    const { DatabaseService } = await import("./database.service");
    const db = app.get(DatabaseService, { strict: false });
    const company = await db.withClaims(SERVICE_CLAIMS, (c) => c.query("SELECT id, name FROM companies WHERE slug = $1", [slug]));
    if (company.rowCount === 0) throw new Error(`No company with slug "${slug}"`);
    if (process.argv.includes("--check")) {
      const admin = await findAdminUser(app, company.rows[0].id);
      await checkFieldKeys(app, company.rows[0].id, { is_platform_admin: false, company_id: company.rows[0].id, sub: admin.id });
      console.log(`CHECK OK: ${company.rows[0].name} - encryption key matches, the seed can write people's details.`);
      return;
    }
    console.log(`Seeding ${company.rows[0].name} (${slug})`);
    const result = await seedDemoTenant(app, company.rows[0].id);
    console.log("DONE", JSON.stringify(result.counts));
    if (result.warnings.length > 0) console.log("WARNINGS:\n  " + result.warnings.join("\n  "));
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("STOPPED:", err.message);
    process.exit(1);
  });
}
